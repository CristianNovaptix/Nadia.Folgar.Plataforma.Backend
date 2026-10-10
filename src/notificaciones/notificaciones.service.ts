import { ClienteHistorialService, TIPO_EVENTO } from '../clientes/cliente-historial.service';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Cliente, ClienteDocument } from '../clientes/schemas/cliente.schema';
import { PaginatedResult } from '../common/dto/pagination-query.dto';
import { MESSAGING_PROVIDER, MessagingProvider } from './ports/messaging-provider.port';
import {
  NotificacionEnviada,
  NotificacionEnviadaDocument,
  CanalEnvio,
  EstadoEnvio,
} from './schemas/notificacion-enviada.schema';
import {
  ReglaNotificacion,
  ReglaNotificacionDocument,
  CanalNotificacion,
} from './schemas/regla-notificacion.schema';
import { Vencimiento, VencimientoDocument, VencimientoEstado } from './schemas/vencimiento.schema';
import {
  NotificacionTemplate,
  PlantillaNotificacion,
  recordatorioHonorariosTemplate,
  vencimientoImpositivoTemplate,
  vencimientoProximoTemplate,
} from './templates/notificacion.templates';
import { CreateVencimientoDto } from './dto/create-vencimiento.dto';
import { UpdateVencimientoDto } from './dto/update-vencimiento.dto';
import { QueryVencimientoDto } from './dto/query-vencimiento.dto';
import { CreateReglaNotificacionDto } from './dto/create-regla-notificacion.dto';
import { UpdateReglaNotificacionDto } from './dto/update-regla-notificacion.dto';
import { QueryReglaNotificacionDto } from './dto/query-regla-notificacion.dto';
import { QueryNotificacionEnviadaDto } from './dto/query-notificacion-enviada.dto';

export interface EvaluarReglasResultado {
  evaluados: number;
  enviados: number;
  omitidos: number;
  errores: number;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

@Injectable()
export class NotificacionesService {
  private readonly logger = new Logger(NotificacionesService.name);

  constructor(
    @InjectModel(Vencimiento.name) private readonly vencimientoModel: Model<VencimientoDocument>,
    @InjectModel(ReglaNotificacion.name)
    private readonly reglaModel: Model<ReglaNotificacionDocument>,
    @InjectModel(NotificacionEnviada.name)
    private readonly notificacionEnviadaModel: Model<NotificacionEnviadaDocument>,
    @InjectModel(Cliente.name) private readonly clienteModel: Model<ClienteDocument>,
    @Inject(MESSAGING_PROVIDER) private readonly messagingProvider: MessagingProvider,
    private readonly historial: ClienteHistorialService,
  ) {}

  // ── Vencimientos ──────────────────────────────────────────────────────

  async findAllVencimientos(
    query: QueryVencimientoDto,
    estudioId: Types.ObjectId,
  ): Promise<PaginatedResult<VencimientoDocument>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const filter: FilterQuery<VencimientoDocument> = { estudioId };

    if (query.estado) {
      filter.estado = query.estado;
    }

    if (query.clienteId) {
      filter.clienteId = new Types.ObjectId(query.clienteId);
    }

    if (query.search) {
      filter.$or = [
        { tipo: { $regex: query.search, $options: 'i' } },
        { descripcion: { $regex: query.search, $options: 'i' } },
      ];
    }

    const sort: Record<string, 1 | -1> = query.sortBy
      ? { [query.sortBy]: query.sortDir === 'desc' ? -1 : 1 }
      : { fecha: 1 };

    const [data, total] = await Promise.all([
      this.vencimientoModel
        .find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.vencimientoModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit };
  }

  async findOneVencimiento(id: string, estudioId: Types.ObjectId): Promise<VencimientoDocument> {
    const vencimiento = await this.vencimientoModel.findOne({ _id: id, estudioId }).exec();
    if (!vencimiento) {
      throw new NotFoundException('Vencimiento no encontrado');
    }
    return vencimiento;
  }

  async createVencimiento(
    dto: CreateVencimientoDto,
    estudioId: Types.ObjectId,
  ): Promise<VencimientoDocument> {
    return this.vencimientoModel.create({
      ...dto,
      clienteId: new Types.ObjectId(dto.clienteId),
      fecha: new Date(dto.fecha),
      estudioId,
    });
  }

  async updateVencimiento(
    id: string,
    dto: UpdateVencimientoDto,
    estudioId: Types.ObjectId,
  ): Promise<VencimientoDocument> {
    const vencimiento = await this.findOneVencimiento(id, estudioId);
    Object.assign(vencimiento, {
      ...dto,
      clienteId: dto.clienteId ? new Types.ObjectId(dto.clienteId) : vencimiento.clienteId,
      fecha: dto.fecha ? new Date(dto.fecha) : vencimiento.fecha,
    });
    await vencimiento.save();
    return vencimiento;
  }

  async removeVencimiento(id: string, estudioId: Types.ObjectId, usuarioId?: string): Promise<void> {
    const vencimiento = await this.findOneVencimiento(id, estudioId);
    await this.historial.registrarCambioDeOrigen(
      vencimiento.clienteId,
      estudioId,
      TIPO_EVENTO.REGISTRO_ELIMINADO,
      `Se eliminó el vencimiento "${vencimiento.tipo}" del ${new Date(vencimiento.fecha).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`,
      usuarioId,
    );
    await vencimiento.deleteOne();
  }

  // ── Reglas de notificación ───────────────────────────────────────────

  async findAllReglas(
    query: QueryReglaNotificacionDto,
    estudioId: Types.ObjectId,
  ): Promise<PaginatedResult<ReglaNotificacionDocument>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const filter: FilterQuery<ReglaNotificacionDocument> = { estudioId };

    if (query.tipoVencimiento) {
      filter.tipoVencimiento = query.tipoVencimiento;
    }

    if (query.activa !== undefined) {
      filter.activa = query.activa;
    }

    if (query.search) {
      filter.$or = [{ tipoVencimiento: { $regex: query.search, $options: 'i' } }];
    }

    const sort: Record<string, 1 | -1> = query.sortBy
      ? { [query.sortBy]: query.sortDir === 'desc' ? -1 : 1 }
      : { tipoVencimiento: 1 };

    const [data, total] = await Promise.all([
      this.reglaModel
        .find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.reglaModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit };
  }

  async findOneRegla(id: string, estudioId: Types.ObjectId): Promise<ReglaNotificacionDocument> {
    const regla = await this.reglaModel.findOne({ _id: id, estudioId }).exec();
    if (!regla) {
      throw new NotFoundException('Regla de notificación no encontrada');
    }
    return regla;
  }

  async createRegla(
    dto: CreateReglaNotificacionDto,
    estudioId: Types.ObjectId,
  ): Promise<ReglaNotificacionDocument> {
    return this.reglaModel.create({ ...dto, estudioId });
  }

  async updateRegla(
    id: string,
    dto: UpdateReglaNotificacionDto,
    estudioId: Types.ObjectId,
  ): Promise<ReglaNotificacionDocument> {
    const regla = await this.findOneRegla(id, estudioId);
    Object.assign(regla, dto);
    await regla.save();
    return regla;
  }

  async removeRegla(id: string, estudioId: Types.ObjectId): Promise<void> {
    const regla = await this.findOneRegla(id, estudioId);
    await regla.deleteOne();
  }

  // ── Historial de notificaciones enviadas (solo lectura) ──────────────

  async findAllNotificacionesEnviadas(
    query: QueryNotificacionEnviadaDto,
    estudioId: Types.ObjectId,
  ): Promise<PaginatedResult<NotificacionEnviadaDocument>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const filter: FilterQuery<NotificacionEnviadaDocument> = { estudioId };

    if (query.clienteId) {
      filter.clienteId = new Types.ObjectId(query.clienteId);
    }

    if (query.vencimientoId) {
      filter.vencimientoId = new Types.ObjectId(query.vencimientoId);
    }

    if (query.estado) {
      filter.estado = query.estado;
    }

    if (query.canal) {
      filter.canal = query.canal;
    }

    const sort: Record<string, 1 | -1> = query.sortBy
      ? { [query.sortBy]: query.sortDir === 'desc' ? -1 : 1 }
      : { fechaEnvio: -1 };

    const [data, total] = await Promise.all([
      this.notificacionEnviadaModel
        .find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.notificacionEnviadaModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit };
  }

  // ── Motor de reglas ───────────────────────────────────────────────────

  /**
   * Corre diariamente vía cron (ver `evaluarReglasCron`), pero también se
   * expone público para poder dispararlo a mano (ej. desde un endpoint de
   * soporte, o desde un test end-to-end).
   *
   * Recorre los vencimientos que todavía no están cerrados (`estado !==
   * VENCIDO`, no solo `PENDIENTE`) porque un mismo vencimiento puede tener
   * más de una regla asociada disparándose en días distintos (ej. día 3 y
   * día 10 de honorarios) — si el estado pasara a NOTIFICADO tras el primer
   * envío y el filtro fuera estricto por PENDIENTE, la segunda regla nunca
   * se evaluaría. La deduplicación real no depende del estado del
   * vencimiento sino del registro en NotificacionEnviada.
   */
  async evaluarReglas(): Promise<EvaluarReglasResultado> {
    const hoy = new Date();
    const inicioHoy = startOfDay(hoy);
    const finHoy = addDays(inicioHoy, 1);

    const resultado: EvaluarReglasResultado = {
      evaluados: 0,
      enviados: 0,
      omitidos: 0,
      errores: 0,
    };

    const vencimientos = await this.vencimientoModel
      .find({ estado: { $ne: VencimientoEstado.VENCIDO } })
      .exec();

    for (const vencimiento of vencimientos) {
      const reglas = await this.reglaModel
        .find({
          estudioId: vencimiento.estudioId,
          tipoVencimiento: vencimiento.tipo,
          activa: true,
        })
        .exec();

      for (const regla of reglas) {
        resultado.evaluados += 1;

        const fechaAviso = addDays(vencimiento.fecha, -regla.offsetDias);
        if (!isSameDay(fechaAviso, hoy)) {
          continue;
        }

        const yaEnviada = await this.notificacionEnviadaModel
          .exists({
            reglaId: regla._id,
            vencimientoId: vencimiento._id,
            fechaEnvio: { $gte: inicioHoy, $lt: finHoy },
          })
          .exec();

        if (yaEnviada) {
          resultado.omitidos += 1;
          continue;
        }

        await this.enviarAviso(vencimiento, regla, hoy, resultado);
      }
    }

    return resultado;
  }

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async evaluarReglasCron(): Promise<void> {
    const resultado = await this.evaluarReglas();
    this.logger.log(
      `evaluarReglas: evaluados=${resultado.evaluados} enviados=${resultado.enviados} ` +
        `omitidos=${resultado.omitidos} errores=${resultado.errores}`,
    );
  }

  private async enviarAviso(
    vencimiento: VencimientoDocument,
    regla: ReglaNotificacionDocument,
    fechaEnvio: Date,
    resultado: EvaluarReglasResultado,
  ): Promise<void> {
    const cliente = await this.clienteModel.findOne({ _id: vencimiento.clienteId }).exec();
    if (!cliente) {
      this.logger.warn(
        `evaluarReglas: no se encontró el cliente ${vencimiento.clienteId.toString()} del vencimiento ${vencimiento._id.toString()}`,
      );
      resultado.errores += 1;
      return;
    }

    const canales: CanalEnvio[] =
      regla.canal === CanalNotificacion.AMBOS
        ? [CanalEnvio.EMAIL, CanalEnvio.WHATSAPP]
        : [regla.canal === CanalNotificacion.WHATSAPP ? CanalEnvio.WHATSAPP : CanalEnvio.EMAIL];

    for (const canal of canales) {
      const destino = canal === CanalEnvio.EMAIL ? cliente.email : cliente.telefono;

      try {
        if (!destino) {
          throw new Error(
            canal === CanalEnvio.EMAIL
              ? 'El cliente no tiene email cargado'
              : 'El cliente no tiene teléfono cargado',
          );
        }

        const mensaje = this.construirMensaje(regla.plantilla, cliente, vencimiento, regla);
        await this.messagingProvider.sendMessage(destino, `${mensaje.asunto}\n\n${mensaje.cuerpo}`);

        await this.notificacionEnviadaModel.create({
          vencimientoId: vencimiento._id,
          reglaId: regla._id,
          clienteId: vencimiento.clienteId,
          canal,
          fechaEnvio,
          estado: EstadoEnvio.ENVIADO,
          estudioId: vencimiento.estudioId,
        });
        resultado.enviados += 1;

        if (vencimiento.estado === VencimientoEstado.PENDIENTE) {
          vencimiento.estado = VencimientoEstado.NOTIFICADO;
          await vencimiento.save();
        }
      } catch (error) {
        resultado.errores += 1;
        await this.notificacionEnviadaModel.create({
          vencimientoId: vencimiento._id,
          reglaId: regla._id,
          clienteId: vencimiento.clienteId,
          canal,
          fechaEnvio,
          estado: EstadoEnvio.ERROR,
          detalleError: error instanceof Error ? error.message : 'Error desconocido',
          estudioId: vencimiento.estudioId,
        });
      }
    }
  }

  private construirMensaje(
    plantilla: PlantillaNotificacion,
    cliente: ClienteDocument,
    vencimiento: VencimientoDocument,
    regla: ReglaNotificacionDocument,
  ): NotificacionTemplate {
    const fecha = vencimiento.fecha.toLocaleDateString('es-AR');

    switch (plantilla) {
      case PlantillaNotificacion.RECORDATORIO_HONORARIOS:
        return recordatorioHonorariosTemplate({
          clienteNombre: cliente.nombre,
          diasVencido: Math.max(0, -regla.offsetDias),
        });
      case PlantillaNotificacion.VENCIMIENTO_IMPOSITIVO:
        return vencimientoImpositivoTemplate({
          clienteNombre: cliente.nombre,
          tipo: vencimiento.tipo,
          fecha,
          diasRestantes: Math.max(0, regla.offsetDias),
        });
      case PlantillaNotificacion.VENCIMIENTO_PROXIMO:
      default:
        return vencimientoProximoTemplate({
          clienteNombre: cliente.nombre,
          tipo: vencimiento.tipo,
          fecha,
        });
    }
  }
}
