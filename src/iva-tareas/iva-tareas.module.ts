import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Cliente, ClienteSchema } from '../clientes/schemas/cliente.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { TareaPresentacion, TareaPresentacionSchema } from './schemas/tarea-presentacion.schema';
import { TareaAdjunto, TareaAdjuntoSchema } from './schemas/tarea-adjunto.schema';
import { IvaTareasService } from './iva-tareas.service';
import { IvaTareasController } from './iva-tareas.controller';
import { AlertasTareasController } from './alertas-tareas.controller';
import { AlertasTareasService } from './alertas-tareas.service';
import { AlertaTareaEstado, AlertaTareaEstadoSchema } from './schemas/alerta-tarea-estado.schema';
import { DocumentoTextoExtractorService } from './documento-texto-extractor.service';
import { AI_TAREAS_DOCUMENTO_PORT } from './ports/ai-tareas-documento.port';
import { AiTareasDocumentoStubAdapter } from './adapters/ai-tareas-documento-stub.adapter';
import { AnthropicTareasDocumentoAdapter } from './adapters/anthropic-tareas-documento.adapter';
import { OpenAiTareasDocumentoAdapter } from './adapters/openai-tareas-documento.adapter';

/**
 * NOTA: este módulo todavía NO se importa en app.module.ts a propósito —
 * esa integración queda a cargo de otro cambio en paralelo sobre ese mismo
 * archivo, para evitar pisarlo (mismo criterio que NotificacionesModule).
 * Ver FOLGAR-046 a FOLGAR-051.
 *
 * El provider de `AI_TAREAS_DOCUMENTO_PORT` ("Importar tareas desde
 * documento") se selecciona por la misma variable de entorno `AI_PROVIDER`
 * que usa `ExtractosIaModule` (`stub` por defecto — sin credenciales, para
 * desarrollo/tests; `anthropic` usa Claude Sonnet 5; `openai` usa GPT-5.1).
 * `IvaTareasService`/`IvaTareasController` no requieren cambios al cambiar
 * de proveedor — solo este factory.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TareaPresentacion.name, schema: TareaPresentacionSchema },
      { name: TareaAdjunto.name, schema: TareaAdjuntoSchema },
      { name: Cliente.name, schema: ClienteSchema },
      { name: User.name, schema: UserSchema },
      { name: AlertaTareaEstado.name, schema: AlertaTareaEstadoSchema },
    ]),
  ],
  controllers: [IvaTareasController, AlertasTareasController],
  providers: [
    IvaTareasService,
    AlertasTareasService,
    DocumentoTextoExtractorService,
    {
      provide: AI_TAREAS_DOCUMENTO_PORT,
      useFactory: (configService: ConfigService) => {
        const provider = configService.get<string>('AI_PROVIDER');
        if (provider === 'anthropic') return new AnthropicTareasDocumentoAdapter(configService);
        if (provider === 'openai') return new OpenAiTareasDocumentoAdapter(configService);
        return new AiTareasDocumentoStubAdapter();
      },
      inject: [ConfigService],
    },
  ],
  exports: [IvaTareasService],
})
export class IvaTareasModule {}
