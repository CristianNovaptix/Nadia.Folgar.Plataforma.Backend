import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import {
  EstadoExtracto,
  ExtractoBancario,
  ExtractoBancarioDocument,
} from './schemas/extracto-bancario.schema';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * Techo de tiempo en `PROCESANDO` antes de considerar un extracto perdido —
 * bien por encima del timeout propio de `ExtractosIaProcessor.process`
 * (`TIMEOUT_PROCESAMIENTO_MS`, 8 min) para no pisarle el resultado a un job
 * que todavía está corriendo dentro de su propio margen.
 */
const UMBRAL_ESTANCADO_MS = 20 * 60 * 1000;

export interface PurgaEstancadosResultado {
  marcados: number;
}

/**
 * Red de seguridad final contra extractos que quedan en "procesando" para
 * siempre. `ExtractosIaProcessor` ya tiene su propio timeout sobre el
 * pipeline (PDF + IA + validación) para el caso de que el proveedor de IA no
 * responda — pero eso no cubre que el proceso de Node entero se caiga a
 * mitad de un job (crash, redeploy) sin llegar siquiera a ese timeout.
 * Es especialmente relevante en `QUEUE_MODE=inline` (default en dev, ver
 * `extractos-ia.module.ts`): ahí la "cola" es apenas un `setTimeout` en
 * memoria, sin ninguna persistencia — si el proceso se reinicia mientras un
 * extracto está en curso, el job desaparece sin dejar rastro para
 * reintentar, y el documento en Mongo queda en `PROCESANDO` para siempre sin
 * que nada lo notifique.
 *
 * Corre cada 5 minutos (`@Cron`) y fuerza a `ERROR` cualquier
 * `ExtractoBancario` en `PROCESANDO` cuyo `updatedAt` sea más viejo que
 * `UMBRAL_ESTANCADO_MS`. Notifica por el mismo evento `extracto:procesado`
 * que usa `ExtractosIaProcessor.notificar`, para que el Frontend reaccione
 * igual sin importar cuál de los dos mecanismos terminó de resolver el
 * extracto.
 */
@Injectable()
export class ExtractosIaWatchdogService {
  private readonly logger = new Logger(ExtractosIaWatchdogService.name);

  constructor(
    @InjectModel(ExtractoBancario.name)
    private readonly extractoModel: Model<ExtractoBancarioDocument>,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  async purgarEstancados(): Promise<PurgaEstancadosResultado> {
    const limite = new Date(Date.now() - UMBRAL_ESTANCADO_MS);
    const filtro = {
      estado: EstadoExtracto.PROCESANDO,
      updatedAt: { $lt: limite },
    } as FilterQuery<ExtractoBancarioDocument>;

    const estancados = await this.extractoModel.find(filtro).exec();

    for (const extracto of estancados) {
      extracto.estado = EstadoExtracto.ERROR;
      extracto.mensajeError =
        'Se superó el tiempo máximo de procesamiento sin novedades — probablemente el proceso se interrumpió inesperadamente. Volvé a cargar el extracto.';
      await extracto.save();
      this.realtimeGateway.emitToEstudio(extracto.estudioId.toString(), 'extracto:procesado', {
        extractoId: extracto._id.toString(),
        estado: extracto.estado,
        nombreArchivo: extracto.nombreArchivo,
      });
    }

    return { marcados: estancados.length };
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async purgarEstancadosCron(): Promise<void> {
    const { marcados } = await this.purgarEstancados();
    if (marcados > 0) {
      this.logger.warn(
        `purgarEstancados: ${marcados} extracto(s) forzado(s) a error por quedar colgados en "procesando".`,
      );
    }
  }
}
