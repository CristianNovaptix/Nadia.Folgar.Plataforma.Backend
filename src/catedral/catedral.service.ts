import { Inject, Injectable, Logger } from '@nestjs/common';
import { conDesempatePorId } from '../common/utils/orden-estable';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import {
  AsientoContableExportResult,
  CATEDRAL_SYNC_PORT,
  CatedralSyncPort,
  SyncResult,
} from './ports/catedral-sync.port';
import {
  CatedralSyncEstado,
  CatedralSyncLog,
  CatedralSyncLogDocument,
  CatedralSyncOperacion,
} from './schemas/catedral-sync-log.schema';
import { QueryCatedralSyncLogDto } from './dto/query-catedral-sync-log.dto';
import { AsignacionManualDto } from '../asientos-contables/dto/asignacion-manual.dto';
import { PaginatedResult } from '../common/dto/pagination-query.dto';

/**
 * Orquesta las operaciones de sincronización con Catedral. Depende del
 * contrato `CatedralSyncPort` (inyectado vía el token `CATEDRAL_SYNC_PORT`,
 * nunca de una clase concreta) para que el adapter real se pueda intercambiar
 * el día que FOLGAR-029 se resuelva, sin tocar este service.
 *
 * Cada llamada al puerto se registra en `CatedralSyncLog`, éxito o error
 * (checklist FOLGAR-030: "Log de operaciones de integración").
 */
@Injectable()
export class CatedralService {
  private readonly logger = new Logger(CatedralService.name);

  constructor(
    @Inject(CATEDRAL_SYNC_PORT) private readonly catedralSyncPort: CatedralSyncPort,
    @InjectModel(CatedralSyncLog.name)
    private readonly syncLogModel: Model<CatedralSyncLogDocument>,
  ) {}

  async exportarClientes(estudioId: Types.ObjectId): Promise<CatedralSyncLogDocument> {
    return this.ejecutarYRegistrar(CatedralSyncOperacion.EXPORTAR_CLIENTES, estudioId, () =>
      this.catedralSyncPort.exportarClientes(),
    );
  }

  async importarMovimientos(
    origen: unknown,
    estudioId: Types.ObjectId,
  ): Promise<CatedralSyncLogDocument> {
    return this.ejecutarYRegistrar(CatedralSyncOperacion.IMPORTAR_MOVIMIENTOS, estudioId, () =>
      this.catedralSyncPort.importarMovimientos(origen),
    );
  }

  /**
   * Arma y exporta el asiento contable de un extracto ya procesado. No usa
   * el `ejecutarYRegistrar` compartido (que asumen `SyncResult` plano): acá
   * el resultado trae además el archivo generado o el detalle de
   * validación, y ambos casos (éxito y "no cuadra"/"sin clasificar") quedan
   * igual auditados en `CatedralSyncLog`.
   */
  async exportarAsientoContable(
    extractoId: string,
    estudioId: Types.ObjectId,
    asignacionesManuales?: AsignacionManualDto[],
  ): Promise<AsientoContableExportResult> {
    try {
      const resultado = await this.catedralSyncPort.exportarAsientoContable({
        extractoId,
        estudioId: estudioId.toString(),
        asignacionesManuales,
      });

      await this.syncLogModel.create({
        operacion: CatedralSyncOperacion.EXPORTAR_ASIENTO_CONTABLE,
        estudioId,
        estado: resultado.exitoso ? CatedralSyncEstado.EXITO : CatedralSyncEstado.ERROR,
        detalle: resultado.mensaje,
        fecha: new Date(),
      });

      return resultado;
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(`Falló la exportación del asiento contable a Catedral: ${mensaje}`);
      await this.syncLogModel.create({
        operacion: CatedralSyncOperacion.EXPORTAR_ASIENTO_CONTABLE,
        estudioId,
        estado: CatedralSyncEstado.ERROR,
        detalle: mensaje,
        fecha: new Date(),
      });
      return { exitoso: false, mensaje };
    }
  }

  async findLogs(
    query: QueryCatedralSyncLogDto,
    estudioId: Types.ObjectId,
  ): Promise<PaginatedResult<CatedralSyncLogDocument>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const filter: FilterQuery<CatedralSyncLogDocument> = { estudioId };

    if (query.estado) {
      filter.estado = query.estado;
    }

    if (query.operacion) {
      filter.operacion = query.operacion;
    }

    const sort: Record<string, 1 | -1> = query.sortBy
      ? { [query.sortBy]: query.sortDir === 'desc' ? -1 : 1 }
      : { fecha: -1 };

    const [data, total] = await Promise.all([
      this.syncLogModel
        .find(filter)
        .sort(conDesempatePorId(sort))
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.syncLogModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit };
  }

  /** Ejecuta la acción contra el puerto y persiste el resultado (éxito o error) como CatedralSyncLog. */
  private async ejecutarYRegistrar(
    operacion: CatedralSyncOperacion,
    estudioId: Types.ObjectId,
    accion: () => Promise<SyncResult>,
  ): Promise<CatedralSyncLogDocument> {
    try {
      const resultado = await accion();
      return await this.syncLogModel.create({
        operacion,
        estudioId,
        estado: resultado.exitoso ? CatedralSyncEstado.EXITO : CatedralSyncEstado.ERROR,
        detalle: resultado.mensaje,
        fecha: new Date(),
      });
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(`Falló la operación ${operacion} contra Catedral: ${mensaje}`);
      return this.syncLogModel.create({
        operacion,
        estudioId,
        estado: CatedralSyncEstado.ERROR,
        detalle: mensaje,
        fecha: new Date(),
      });
    }
  }
}
