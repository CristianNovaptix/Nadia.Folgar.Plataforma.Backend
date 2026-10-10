import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, Model, Types } from 'mongoose';
import { Cliente, ClienteDocument } from './schemas/cliente.schema';
import { ClienteEvento, ClienteEventoDocument } from './schemas/cliente-evento.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  ExtractoBancario,
  ExtractoBancarioDocument,
} from '../extractos-ia/schemas/extracto-bancario.schema';
import { Reunion, ReunionDocument } from '../inicio/schemas/reunion.schema';
import { Documento, DocumentoDocument } from '../portal-clientes/schemas/documento.schema';
import { Comunicado, ComunicadoDocument } from '../portal-clientes/schemas/comunicado.schema';
import { Factura, FacturaDocument } from '../facturacion-electronica/schemas/factura.schema';
import { Vencimiento, VencimientoDocument } from '../notificaciones/schemas/vencimiento.schema';
import {
  NotificacionEnviada,
  NotificacionEnviadaDocument,
} from '../notificaciones/schemas/notificacion-enviada.schema';
import {
  TareaPresentacion,
  TareaPresentacionDocument,
} from '../iva-tareas/schemas/tarea-presentacion.schema';

/** Tipos de evento del historial — el Frontend elige el ícono por este valor. */
export const TIPO_EVENTO = {
  CLIENTE_CREADO: 'cliente_creado',
  CLIENTE_EDITADO: 'cliente_editado',
  CLIENTE_ACTIVADO: 'cliente_activado',
  CLIENTE_DESACTIVADO: 'cliente_desactivado',
  CLIENTE_PAPELERA: 'cliente_papelera',
  CLIENTE_RESTAURADO: 'cliente_restaurado',
  USUARIO_PORTAL_CREADO: 'usuario_portal_creado',
  PASSWORD_PORTAL_CAMBIADA: 'password_portal_cambiada',
  EXTRACTO_SUBIDO: 'extracto_subido',
  REUNION: 'reunion',
  DOCUMENTO_SUBIDO: 'documento_subido',
  COMUNICADO: 'comunicado',
  FACTURA_CREADA: 'factura_creada',
  FACTURA_EMITIDA: 'factura_emitida',
  VENCIMIENTO_CARGADO: 'vencimiento_cargado',
  NOTIFICACION_ENVIADA: 'notificacion_enviada',
  TAREA_CREADA: 'tarea_creada',
  /** Algo de otro módulo (reunión, tarea, extracto, etc.) que se mandó a la papelera. */
  REGISTRO_PAPELERA: 'registro_papelera',
  REGISTRO_RESTAURADO: 'registro_restaurado',
  REGISTRO_ELIMINADO: 'registro_eliminado',
} as const;

interface EventoNuevo {
  tipo: string;
  descripcion: string;
  fecha: Date;
  origenId?: Types.ObjectId;
  usuarioId?: Types.ObjectId;
}

type ConFechas = { _id: Types.ObjectId; createdAt?: Date };

function fechaCorta(fecha: Date): string {
  return new Date(fecha).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
}

function horaCorta(fecha: Date): string {
  return new Date(fecha).toLocaleTimeString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function pesos(monto: number): string {
  return monto.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
}

@Injectable()
export class ClienteHistorialService {
  private readonly logger = new Logger(ClienteHistorialService.name);

  constructor(
    @InjectModel(ClienteEvento.name) private readonly eventoModel: Model<ClienteEventoDocument>,
    @InjectModel(Cliente.name) private readonly clienteModel: Model<ClienteDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(ExtractoBancario.name)
    private readonly extractoModel: Model<ExtractoBancarioDocument>,
    @InjectModel(Reunion.name) private readonly reunionModel: Model<ReunionDocument>,
    @InjectModel(Documento.name) private readonly documentoModel: Model<DocumentoDocument>,
    @InjectModel(Comunicado.name) private readonly comunicadoModel: Model<ComunicadoDocument>,
    @InjectModel(Factura.name) private readonly facturaModel: Model<FacturaDocument>,
    @InjectModel(Vencimiento.name) private readonly vencimientoModel: Model<VencimientoDocument>,
    @InjectModel(NotificacionEnviada.name)
    private readonly notificacionModel: Model<NotificacionEnviadaDocument>,
    @InjectModel(TareaPresentacion.name)
    private readonly tareaModel: Model<TareaPresentacionDocument>,
  ) {}

  /**
   * Graba una acción hecha sobre el cliente. Nunca tira error: si falla el
   * historial, la acción principal (que ya se hizo) no se tiene que romper.
   */
  async registrar(
    clienteId: string | Types.ObjectId,
    estudioId: Types.ObjectId,
    evento: Omit<EventoNuevo, 'fecha' | 'usuarioId'> & { fecha?: Date },
    usuarioId?: string,
  ): Promise<void> {
    try {
      const usuario = usuarioId
        ? await this.userModel.findById(usuarioId).select('nombre').lean().exec()
        : null;
      await this.eventoModel.create({
        ...evento,
        fecha: evento.fecha ?? new Date(),
        clienteId: new Types.ObjectId(clienteId),
        estudioId,
        usuarioId: usuario?._id,
        usuarioNombre: usuario?.nombre,
      });
    } catch (err) {
      this.logger.warn(`No se pudo registrar el evento ${evento.tipo}: ${(err as Error).message}`);
    }
  }

  /**
   * Para cuando se elimina, se manda a la papelera o se restaura algo de otro
   * módulo que tiene cliente. Se llama ANTES de borrarlo: primero copia al
   * historial lo que todavía no esté (así su alta no se pierde aunque nadie
   * haya abierto el historial antes) y después graba quién y cuándo.
   */
  async registrarCambioDeOrigen(
    clienteId: Types.ObjectId | string | undefined | null,
    estudioId: Types.ObjectId,
    tipo: string,
    descripcion: string,
    usuarioId?: string,
  ): Promise<void> {
    if (!clienteId) return;
    try {
      const id = new Types.ObjectId(clienteId);
      const cliente = await this.clienteModel
        .findOne({ _id: id, estudioId })
        .select('createdAt')
        .lean<ConFechas>()
        .exec();
      if (cliente) await this.sincronizar(id, estudioId, cliente);
    } catch (err) {
      this.logger.warn(`No se pudo sincronizar el historial: ${(err as Error).message}`);
    }
    await this.registrar(clienteId, estudioId, { tipo, descripcion }, usuarioId);
  }

  async listar(clienteId: string, estudioId: Types.ObjectId) {
    if (!Types.ObjectId.isValid(clienteId)) throw new NotFoundException('Cliente no encontrado');
    const id = new Types.ObjectId(clienteId);
    const cliente = await this.clienteModel
      .findOne({ _id: id, estudioId })
      .select('createdAt')
      .lean<ConFechas>()
      .exec();
    if (!cliente) throw new NotFoundException('Cliente no encontrado');

    await this.sincronizar(id, estudioId, cliente);

    return this.eventoModel
      .find({ clienteId: id, estudioId })
      .sort({ fecha: -1, createdAt: -1 })
      .select('tipo descripcion fecha usuarioNombre')
      .lean()
      .exec();
  }

  /**
   * Copia al historial los registros de otros módulos que todavía no estén
   * (upsert con `$setOnInsert`): una vez copiados quedan guardados aunque
   * después se borre el registro original.
   */
  private async sincronizar(id: Types.ObjectId, estudioId: Types.ObjectId, cliente: ConFechas) {
    const filtro = { clienteId: id, estudioId };
    const [usuarios, extractos, reuniones, documentos, comunicados, facturas, vencimientos, avisos, tareas] =
      await Promise.all([
        this.userModel.find({ clienteId: id }).select('email createdAt').lean().exec(),
        this.extractoModel.find(filtro).select('nombreArchivo periodo createdAt').lean().exec(),
        this.reunionModel.find(filtro).select('titulo fecha creadoPor createdAt').lean().exec(),
        this.documentoModel.find(filtro).select('nombre createdAt').lean().exec(),
        this.comunicadoModel.find(filtro).select('titulo createdAt').lean().exec(),
        this.facturaModel
          .find(filtro)
          .select('concepto monto numeroComprobante fechaEmision createdAt')
          .lean()
          .exec(),
        this.vencimientoModel.find(filtro).select('tipo fecha createdAt').lean().exec(),
        this.notificacionModel.find(filtro).select('canal fechaEnvio estado').lean().exec(),
        this.tareaModel
          .find(filtro)
          .select('titulo jurisdiccion periodo creadoPor createdAt')
          .lean()
          .exec(),
      ]);

    const eventos: EventoNuevo[] = [];
    const creado = (doc: { createdAt?: Date }) => doc.createdAt ?? new Date();

    eventos.push({
      tipo: TIPO_EVENTO.CLIENTE_CREADO,
      descripcion: 'Se dio de alta el cliente',
      fecha: creado(cliente),
      origenId: cliente._id,
    });
    for (const u of usuarios as Array<ConFechas & { email?: string }>) {
      eventos.push({
        tipo: TIPO_EVENTO.USUARIO_PORTAL_CREADO,
        descripcion: `Se creó el usuario del portal${u.email ? ` (${u.email})` : ''}`,
        fecha: creado(u),
        origenId: u._id,
      });
    }
    for (const e of extractos as Array<ConFechas & { nombreArchivo: string; periodo: string }>) {
      eventos.push({
        tipo: TIPO_EVENTO.EXTRACTO_SUBIDO,
        descripcion: `Se generó el extracto "${e.nombreArchivo}" (período ${e.periodo})`,
        fecha: creado(e),
        origenId: e._id,
      });
    }
    for (const r of reuniones as Array<
      ConFechas & { titulo: string; fecha: Date; creadoPor?: Types.ObjectId }
    >) {
      eventos.push({
        tipo: TIPO_EVENTO.REUNION,
        descripcion: `Se creó la reunión "${r.titulo}" para el día ${fechaCorta(r.fecha)} a las ${horaCorta(r.fecha)} hs`,
        fecha: r.createdAt ?? r.fecha,
        origenId: r._id,
        usuarioId: r.creadoPor,
      });
    }
    for (const d of documentos as Array<ConFechas & { nombre: string }>) {
      eventos.push({
        tipo: TIPO_EVENTO.DOCUMENTO_SUBIDO,
        descripcion: `Se subió el documento "${d.nombre}"`,
        fecha: creado(d),
        origenId: d._id,
      });
    }
    for (const c of comunicados as Array<ConFechas & { titulo: string }>) {
      eventos.push({
        tipo: TIPO_EVENTO.COMUNICADO,
        descripcion: `Se le envió el comunicado "${c.titulo}"`,
        fecha: creado(c),
        origenId: c._id,
      });
    }
    for (const f of facturas as Array<
      ConFechas & { concepto: string; monto: number; numeroComprobante?: string; fechaEmision?: Date }
    >) {
      eventos.push({
        tipo: TIPO_EVENTO.FACTURA_CREADA,
        descripcion: `Se cargó la prefactura "${f.concepto}" por ${pesos(f.monto)}`,
        fecha: creado(f),
        origenId: f._id,
      });
      if (f.fechaEmision) {
        eventos.push({
          tipo: TIPO_EVENTO.FACTURA_EMITIDA,
          descripcion: `Se emitió la factura${f.numeroComprobante ? ` N° ${f.numeroComprobante}` : ''} por ${pesos(f.monto)}`,
          fecha: f.fechaEmision,
          origenId: f._id,
        });
      }
    }
    for (const v of vencimientos as Array<ConFechas & { tipo: string; fecha: Date }>) {
      eventos.push({
        tipo: TIPO_EVENTO.VENCIMIENTO_CARGADO,
        descripcion: `Se cargó el vencimiento "${v.tipo}" del ${fechaCorta(v.fecha)}`,
        fecha: creado(v),
        origenId: v._id,
      });
    }
    for (const a of avisos as Array<ConFechas & { canal: string; fechaEnvio: Date; estado: string }>) {
      eventos.push({
        tipo: TIPO_EVENTO.NOTIFICACION_ENVIADA,
        descripcion: `Se le envió un aviso de vencimiento por ${a.canal} (${a.estado})`,
        fecha: a.fechaEnvio,
        origenId: a._id,
      });
    }
    for (const t of tareas as Array<
      ConFechas & { titulo?: string; jurisdiccion?: string; periodo: string; creadoPor?: Types.ObjectId }
    >) {
      const nombre = t.titulo || [t.jurisdiccion, t.periodo].filter(Boolean).join(' ');
      eventos.push({
        tipo: TIPO_EVENTO.TAREA_CREADA,
        descripcion: `Se creó la tarea "${nombre}"`,
        fecha: creado(t),
        origenId: t._id,
        usuarioId: t.creadoPor,
      });
    }

    const usuarioIds = [...new Set(eventos.map((e) => e.usuarioId?.toString()).filter(Boolean))];
    const nombres = new Map(
      (await this.userModel.find({ _id: { $in: usuarioIds } }).select('nombre').lean().exec()).map(
        (u) => [u._id.toString(), u.nombre],
      ),
    );

    const ops: AnyBulkWriteOperation<ClienteEvento>[] = eventos.map((e) => ({
      updateOne: {
        filter: { clienteId: id, tipo: e.tipo, origenId: e.origenId },
        update: {
          $setOnInsert: {
            ...e,
            clienteId: id,
            estudioId,
            usuarioNombre: e.usuarioId ? nombres.get(e.usuarioId.toString()) : undefined,
          },
        },
        upsert: true,
      },
    }));
    try {
      await this.eventoModel.bulkWrite(ops, { ordered: false });
    } catch (err) {
      // Dos consultas simultáneas pueden chocar en el índice único: no es un problema real.
      this.logger.warn(`Sincronización parcial del historial: ${(err as Error).message}`);
    }
  }
}
