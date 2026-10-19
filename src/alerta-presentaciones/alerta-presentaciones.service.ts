import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { conDesempatePorId } from '../common/utils/orden-estable';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Cliente, ClienteDocument } from '../clientes/schemas/cliente.schema';
import { PaginatedResult } from '../common/dto/pagination-query.dto';
import {
  MESSAGING_PROVIDER,
  MessagingProvider,
} from '../notificaciones/ports/messaging-provider.port';
import { ARCA_MONITOR_PORT, ArcaMonitorPort } from './ports/arca-monitor.port';
import {
  NovedadFiscal,
  NovedadFiscalDocument,
  NovedadFiscalEstado,
} from './schemas/novedad-fiscal.schema';
import { QueryNovedadFiscalDto } from './dto/query-novedad-fiscal.dto';

/**
 * Casilla del "equipo" del estudio que recibe el aviso cuando se detecta una
 * novedad fiscal nueva (checklist FOLGAR-043: "Definir destinatarios por
 * tipo de novedad"). Simplificación deliberada para este alcance: en vez de
 * modelar una lista de destinatarios configurable por estudio/rol, se avisa
 * a una única casilla fija del equipo. Como el `MessagingProvider` activo
 * hoy es el adapter stub de email (ver `alerta-presentaciones.module.ts`),
 * esto no envía ningún correo real — solo lo loguea. Si el estudio necesita
 * varios destinatarios o reglas por tipo de novedad, este es el punto de
 * reemplazo.
 */
const EMAIL_EQUIPO_ESTUDIO = 'equipo@estudio-folgar.com.ar';

export interface MonitorearResultado {
  clientesRevisados: number;
  novedadesDetectadas: number;
  novedadesNuevas: number;
  errores: number;
}

@Injectable()
export class AlertaPresentacionesService {
  private readonly logger = new Logger(AlertaPresentacionesService.name);

  constructor(
    @InjectModel(NovedadFiscal.name)
    private readonly novedadFiscalModel: Model<NovedadFiscalDocument>,
    @InjectModel(Cliente.name) private readonly clienteModel: Model<ClienteDocument>,
    @Inject(ARCA_MONITOR_PORT) private readonly arcaMonitorPort: ArcaMonitorPort,
    @Inject(MESSAGING_PROVIDER) private readonly messagingProvider: MessagingProvider,
  ) {}

  // ── Bandeja de alertas (CRUD paginado de solo lectura + cambio de estado) ─

  async findAll(
    query: QueryNovedadFiscalDto,
    estudioId: Types.ObjectId,
  ): Promise<PaginatedResult<NovedadFiscalDocument>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const filter: FilterQuery<NovedadFiscalDocument> = { estudioId };

    if (query.clienteId) {
      filter.clienteId = new Types.ObjectId(query.clienteId);
    }

    if (query.estado) {
      filter.estado = query.estado;
    }

    if (query.search) {
      filter.$or = [
        { descripcion: { $regex: query.search, $options: 'i' } },
        { referenciaExterna: { $regex: query.search, $options: 'i' } },
      ];
    }

    const sort: Record<string, 1 | -1> = query.sortBy
      ? { [query.sortBy]: query.sortDir === 'desc' ? -1 : 1 }
      : { fecha: -1 };

    const [data, total] = await Promise.all([
      this.novedadFiscalModel
        .find(filter)
        .sort(conDesempatePorId(sort))
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.novedadFiscalModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: string, estudioId: Types.ObjectId): Promise<NovedadFiscalDocument> {
    const novedad = await this.novedadFiscalModel.findOne({ _id: id, estudioId }).exec();
    if (!novedad) {
      throw new NotFoundException('Novedad fiscal no encontrada');
    }
    return novedad;
  }

  async marcarComoVista(id: string, estudioId: Types.ObjectId): Promise<NovedadFiscalDocument> {
    return this.actualizarEstado(id, NovedadFiscalEstado.VISTA, estudioId);
  }

  async marcarComoResuelta(id: string, estudioId: Types.ObjectId): Promise<NovedadFiscalDocument> {
    return this.actualizarEstado(id, NovedadFiscalEstado.RESUELTA, estudioId);
  }

  async actualizarEstado(
    id: string,
    estado: NovedadFiscalEstado.VISTA | NovedadFiscalEstado.RESUELTA,
    estudioId: Types.ObjectId,
  ): Promise<NovedadFiscalDocument> {
    const novedad = await this.findOne(id, estudioId);
    novedad.estado = estado;
    await novedad.save();
    return novedad;
  }

  // ── Monitoreo periódico (FOLGAR-042/043) ──────────────────────────────

  /**
   * Corre diariamente vía cron (ver `monitorearTodosCron`), pero también se
   * expone público para poder dispararlo a mano (endpoint `POST
   * /alerta-presentaciones/monitorear`, o desde un test).
   *
   * Recorre los clientes activos (sin filtrar por un único `estudioId`, ya
   * que el cron no tiene contexto de request — mismo criterio que
   * `NotificacionesService.evaluarReglas()`, que recorre vencimientos de
   * todos los estudios y deriva el tenant por registro) y consulta el
   * puerto `ArcaMonitorPort` por cada uno. Hoy ese puerto es el adapter
   * stub (`ArcaMonitorStubAdapter`), que siempre devuelve `[]` — este
   * método queda completamente ejercitado y testeado igual, listo para
   * cuando el adapter real empiece a devolver novedades.
   *
   * Deduplicación: antes de crear una `NovedadFiscal`, se verifica si ya
   * existe una con la misma combinación estudioId+clienteId+referenciaExterna.
   * Si existe, se omite (puede repetirse entre corridas del cron, o incluso
   * dentro de una misma corrida si el adapter devuelve la misma novedad más
   * de una vez).
   */
  async monitorearTodos(): Promise<MonitorearResultado> {
    const resultado: MonitorearResultado = {
      clientesRevisados: 0,
      novedadesDetectadas: 0,
      novedadesNuevas: 0,
      errores: 0,
    };

    const clientes = await this.clienteModel.find({ activo: true }).exec();

    for (const cliente of clientes) {
      resultado.clientesRevisados += 1;

      try {
        const novedades = await this.arcaMonitorPort.consultarNovedades(cliente._id.toString());
        resultado.novedadesDetectadas += novedades.length;

        for (const novedad of novedades) {
          const yaExiste = await this.novedadFiscalModel
            .exists({
              estudioId: cliente.estudioId,
              clienteId: cliente._id,
              referenciaExterna: novedad.referenciaExterna,
            })
            .exec();

          if (yaExiste) {
            continue;
          }

          const creada = await this.novedadFiscalModel.create({
            clienteId: cliente._id,
            referenciaExterna: novedad.referenciaExterna,
            descripcion: novedad.descripcion,
            fecha: novedad.fecha,
            estado: NovedadFiscalEstado.NUEVA,
            estudioId: cliente.estudioId,
          });

          resultado.novedadesNuevas += 1;
          await this.notificarEquipo(cliente, creada);
        }
      } catch (error) {
        resultado.errores += 1;
        this.logger.error(
          `monitorearTodos: falló la consulta de novedades para el cliente ${cliente._id.toString()}: ` +
            `${error instanceof Error ? error.message : 'error desconocido'}`,
        );
      }
    }

    return resultado;
  }

  @Cron(CronExpression.EVERY_DAY_AT_7AM)
  async monitorearTodosCron(): Promise<void> {
    const resultado = await this.monitorearTodos();
    this.logger.log(
      `monitorearTodos: clientesRevisados=${resultado.clientesRevisados} ` +
        `novedadesDetectadas=${resultado.novedadesDetectadas} novedadesNuevas=${resultado.novedadesNuevas} ` +
        `errores=${resultado.errores}`,
    );
  }

  /**
   * Envía el aviso de novedad nueva al equipo del estudio vía el puerto
   * `MessagingProvider` (hoy el adapter stub de email, reutilizado tal cual
   * de `notificaciones/` — ver `alerta-presentaciones.module.ts`). Atrapa
   * cualquier error deliberadamente: un fallo del canal de notificación
   * nunca debe hacer fallar el monitoreo ni la persistencia de la novedad,
   * que ya se guardó en `NovedadFiscal` de todos modos (queda visible en la
   * bandeja de alertas aunque el aviso no haya salido).
   */
  private async notificarEquipo(
    cliente: ClienteDocument,
    novedad: NovedadFiscalDocument,
  ): Promise<void> {
    const asunto = `Nueva novedad fiscal detectada — ${cliente.nombre}`;
    const cuerpo =
      `Se detectó una novedad en el Domicilio Fiscal Electrónico de "${cliente.nombre}" ` +
      `(CUIT ${cliente.cuit}):\n\n${novedad.descripcion}\n\n` +
      `Fecha: ${novedad.fecha.toLocaleDateString('es-AR')}\nReferencia: ${novedad.referenciaExterna}`;

    try {
      await this.messagingProvider.sendMessage(EMAIL_EQUIPO_ESTUDIO, `${asunto}\n\n${cuerpo}`);
    } catch (error) {
      this.logger.error(
        `No se pudo notificar al equipo sobre la novedad ${novedad._id.toString()} del cliente ` +
          `${cliente._id.toString()}: ${error instanceof Error ? error.message : 'error desconocido'}`,
      );
    }
  }
}
