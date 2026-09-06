import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ExtractoBancario, ExtractoBancarioSchema } from './schemas/extracto-bancario.schema';
import {
  EXTRACTOS_PROCESSING_QUEUE,
  ExtractosIaService,
  ExtractosProcessingQueue,
} from './extractos-ia.service';
import { ExtractosIaController } from './extractos-ia.controller';
import { ExtractosIaProcessor, ProcesarExtractoJobData } from './extractos-ia.processor';
import { ExtractosIaWatchdogService } from './extractos-ia-watchdog.service';
import { AiExtractionStubAdapter } from './adapters/ai-extraction-stub.adapter';
import { AnthropicExtractionAdapter } from './adapters/anthropic-extraction.adapter';
import { OpenAiExtractionAdapter } from './adapters/openai-extraction.adapter';
import { PdfTextExtractorService } from './pdf-text-extractor.service';
import { ExtractoDeteccionService } from './extracto-deteccion.service';
import { CuentasBancariasModule } from '../cuentas-bancarias/cuentas-bancarias.module';
import { PlanCuentasModule } from '../plan-cuentas/plan-cuentas.module';
import { ReglasClasificacionModule } from '../reglas-clasificacion/reglas-clasificacion.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { useRedisQueues } from '../config/queue-mode';

const redisQueuesEnabled = useRedisQueues();
const queueImports = redisQueuesEnabled ? [BullModule.registerQueue({ name: 'extractos-ia' })] : [];
const inlineQueueLogger = new Logger('InlineExtractosQueue');

/**
 * Módulo "Procesador de Extractos con IA" (backlog FOLGAR-007 a FOLGAR-012,
 * ampliado luego con validación de saldo y procesamiento asíncrono — ver
 * plan de ejecución).
 *
 * DECISIÓN DE SCOPE — carga de archivos: en vez de upload multipart (que
 * requeriría registrar `@fastify/multipart` en `main.ts`, archivo compartido
 * que tampoco corresponde tocar acá), la carga usa un DTO JSON con
 * `nombreArchivo` + `contenidoBase64`. El Frontend convierte el PDF elegido
 * por el usuario a base64 con `FileReader` antes de llamar al endpoint.
 *
 * PROCESAMIENTO ASÍNCRONO: `ExtractosIaService.cargarExtracto` solo valida,
 * crea el documento (`PROCESANDO`) y encola un job en la cola BullMQ
 * `extractos-ia` (Redis, ver `REDIS_URL`) — responde en milisegundos.
 * `ExtractosIaProcessor` es el worker que hace el trabajo pesado (extraer
 * texto, llamar a la IA, validar saldo) fuera de la request HTTP, y notifica
 * el resultado por WebSocket vía `RealtimeGateway` (`RealtimeModule`) cuando
 * termina. Reemplaza el procesamiento 100% síncrono que tenía este módulo
 * antes, que dejó de alcanzar en cuanto la IA empezó a tardar más que el
 * timeout HTTP del Frontend.
 *
 * PROVEEDOR DE IA: `ExtractosIaProcessor` inyecta los tres adapters
 * (Anthropic/OpenAI/Stub) directo y resuelve cuál usar en cada job vía
 * `AiProviderResolverService` (`ConfiguracionModule` — Configuración →
 * Integraciones, con fallback a `AI_PROVIDER` de entorno y, sin nada
 * configurado, al stub). Reemplaza el factory estático que este módulo tenía
 * antes.
 *
 * `ExtractosIaProcessor` también inyecta `PlanCuentasModule` y
 * `ReglasClasificacionModule`: en la misma llamada de IA que transcribe los
 * movimientos, le pasa el plan de cuentas del cliente y le pide que infiera
 * reglas de clasificación para patrones recurrentes (`reglasSugeridas`),
 * que quedan creadas y activas de inmediato con `procedencia: 'ia'`.
 *
 * `ExtractosIaWatchdogService` (cron cada 5 min) es la red de seguridad
 * final contra extractos que quedan en `PROCESANDO` para siempre — cubre el
 * caso de que el proceso de Node se caiga a mitad de un job (más probable en
 * `QUEUE_MODE=inline`, sin persistencia de la cola) además del timeout
 * propio que ya tiene `ExtractosIaProcessor` sobre el pipeline.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: ExtractoBancario.name, schema: ExtractoBancarioSchema }]),
    ...queueImports,
    CuentasBancariasModule,
    PlanCuentasModule,
    ReglasClasificacionModule,
    RealtimeModule,
    ConfiguracionModule,
  ],
  controllers: [ExtractosIaController],
  providers: [
    ExtractosIaService,
    ExtractosIaProcessor,
    ExtractosIaWatchdogService,
    PdfTextExtractorService,
    ExtractoDeteccionService,
    AnthropicExtractionAdapter,
    OpenAiExtractionAdapter,
    AiExtractionStubAdapter,
    {
      provide: EXTRACTOS_PROCESSING_QUEUE,
      useFactory: (
        processor: ExtractosIaProcessor,
        redisQueue?: Queue<ProcesarExtractoJobData>,
      ): ExtractosProcessingQueue => {
        if (redisQueuesEnabled && redisQueue) return redisQueue;

        return {
          add(_name: 'procesar', data: ProcesarExtractoJobData): Promise<void> {
            setTimeout(() => {
              void processor
                .process({ data } as never)
                .catch((error: unknown) =>
                  inlineQueueLogger.error(
                    error instanceof Error ? error.stack || error.message : String(error),
                  ),
                );
            }, 0);
            return Promise.resolve();
          },
        };
      },
      inject: redisQueuesEnabled
        ? [ExtractosIaProcessor, getQueueToken('extractos-ia')]
        : [ExtractosIaProcessor],
    },
  ],
  exports: [ExtractosIaService],
})
export class ExtractosIaModule {}
