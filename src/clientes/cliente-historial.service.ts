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

/**
 * Eventos de Finanzas → Honorarios (`EVENTO_FINANZAS`): tienen importes, así
 * que solo los ve quien tiene Finanzas completo.
 */
const TIPO_FINANZAS = /^honorario_/;

interface EventoNuevo {
  clienteId: Types.ObjectId;
  tipo: string;
  descripcion: string;
  fecha: Date;
  origenId?: Types.ObjectId;
  usuarioId?: Types.ObjectId;
}

type ConFechas = {
  _id: Types.ObjectId;
  createdAt?: Date;
  esPrueba?: boolean;
  creadoPor?: Types.ObjectId;
};
type ConCliente = ConFechas & { clienteId: Types.ObjectId };

export interface QueryActividad {
  skip?: number;
  limit?: number;
  tipos?: string[];
  clienteIds?: string[];
  usuario?: string;
  desde?: string;
  hasta?: string;
  q?: string;
}

/** Cada cuánto se vuelve a copiar al historial lo nuevo de todos los clientes. */
const SYNC_GLOBAL_MS = 30_000;

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  private readonly ultimaSyncGlobal = new Map<string, number>();

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
    evento: Omit<EventoNuevo, 'fecha' | 'usuarioId' | 'clienteId'> & { fecha?: Date },
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
        .select('createdAt esPrueba creadoPor')
        .lean<ConFechas>()
        .exec();
      if (cliente) await this.sincronizar(estudioId, [cliente]);
    } catch (err) {
      this.logger.warn(`No se pudo sincronizar el historial: ${(err as Error).message}`);
    }
    await this.registrar(clienteId, estudioId, { tipo, descripcion }, usuarioId);
  }

  /** `verFinanzas: false` deja afuera lo de honorarios (abonos, deudas, pagos). */
  async listar(clienteId: string, estudioId: Types.ObjectId, verFinanzas = true) {
    if (!Types.ObjectId.isValid(clienteId)) throw new NotFoundException('Cliente no encontrado');
    const id = new Types.ObjectId(clienteId);
    const cliente = await this.clienteModel
      .findOne({ _id: id, estudioId })
      .select('createdAt esPrueba creadoPor')
      .lean<ConFechas>()
      .exec();
    if (!cliente) throw new NotFoundException('Cliente no encontrado');

    await this.sincronizar(estudioId, [cliente]);

    return this.eventoModel
      .find({ clienteId: id, estudioId, ...(verFinanzas ? {} : { tipo: { $not: TIPO_FINANZAS } }) })
      .sort({ fecha: -1, createdAt: -1 })
      .select('tipo descripcion fecha usuarioNombre esPrueba')
      .lean()
      .exec();
  }

  /**
   * Historial de todos los clientes del estudio ("Ver toda la actividad" del
   * Inicio), de lo más nuevo a lo más viejo, paginado y con filtros.
   */
  async listarEstudio(estudioId: Types.ObjectId, query: QueryActividad, verFinanzas = true) {
    const clave = estudioId.toString();
    if (Date.now() - (this.ultimaSyncGlobal.get(clave) ?? 0) > SYNC_GLOBAL_MS) {
      const clientes = await this.clienteModel
        .find({ estudioId })
        .select('createdAt esPrueba creadoPor')
        .lean<ConFechas[]>()
        .exec();
      await this.sincronizar(estudioId, clientes);
      this.ultimaSyncGlobal.set(clave, Date.now());
    }

    const filtro: Record<string, unknown> = { estudioId };
    if (query.tipos?.length) filtro.tipo = { $in: query.tipos };
    if (!verFinanzas) filtro.tipo = { ...(filtro.tipo as object), $not: TIPO_FINANZAS };
    const clienteIds = (query.clienteIds ?? []).filter((id) => Types.ObjectId.isValid(id));
    if (clienteIds.length) {
      filtro.clienteId = { $in: clienteIds.map((id) => new Types.ObjectId(id)) };
    }
    if (query.usuario) filtro.usuarioNombre = query.usuario;
    if (query.desde || query.hasta) {
      const fecha: Record<string, Date> = {};
      if (query.desde) fecha.$gte = new Date(`${query.desde}T00:00:00-03:00`);
      if (query.hasta) fecha.$lte = new Date(`${query.hasta}T23:59:59.999-03:00`);
      filtro.fecha = fecha;
    }
    if (query.q?.trim()) {
      const texto = escaparRegex(query.q.trim());
      const clientesQueCoinciden = await this.clienteModel
        .find({ estudioId, nombre: { $regex: texto, $options: 'i' } })
        .select('_id')
        .lean()
        .exec();
      filtro.$or = [
        { descripcion: { $regex: texto, $options: 'i' } },
        { usuarioNombre: { $regex: texto, $options: 'i' } },
        { clienteId: { $in: clientesQueCoinciden.map((c) => c._id) } },
      ];
    }

    const skip = Math.max(0, query.skip ?? 0);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const [eventos, total, usuarios] = await Promise.all([
      this.eventoModel
        .find(filtro)
        .sort({ fecha: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('tipo descripcion fecha usuarioNombre esPrueba clienteId origenId')
        .lean<
          Array<{
            _id: Types.ObjectId;
            tipo: string;
            descripcion: string;
            fecha: Date;
            usuarioNombre?: string;
            esPrueba?: boolean;
            clienteId: Types.ObjectId;
            origenId?: Types.ObjectId;
          }>
        >()
        .exec(),
      this.eventoModel.countDocuments(filtro).exec(),
      this.eventoModel.distinct('usuarioNombre', { estudioId }).exec(),
    ]);

    // Datos para llevar al lugar exacto: el período de la tarea, el día de la reunión.
    const origenes = (tipo: string) =>
      eventos.filter((e) => e.tipo === tipo && e.origenId).map((e) => e.origenId);
    const [clientes, tareas, reuniones] = await Promise.all([
      this.clienteModel
        .find({ _id: { $in: [...new Set(eventos.map((e) => e.clienteId.toString()))] } })
        .select('nombre')
        .lean()
        .exec(),
      this.tareaModel
        .find({ _id: { $in: origenes(TIPO_EVENTO.TAREA_CREADA) } })
        .select('periodo')
        .lean()
        .exec(),
      this.reunionModel
        .find({ _id: { $in: origenes(TIPO_EVENTO.REUNION) } })
        .select('fecha')
        .lean()
        .exec(),
    ]);
    const nombreCliente = new Map(clientes.map((c) => [c._id.toString(), c.nombre]));
    const periodoTarea = new Map(tareas.map((t) => [t._id.toString(), t.periodo]));
    const fechaReunion = new Map(reuniones.map((r) => [r._id.toString(), r.fecha]));

    return {
      total,
      usuarios: (usuarios as Array<string | null>).filter((u): u is string => Boolean(u)).sort(),
      items: eventos.map((e) => {
        const origen = e.origenId?.toString();
        return {
          ...e,
          clienteNombre: nombreCliente.get(e.clienteId.toString()),
          periodo: origen ? periodoTarea.get(origen) : undefined,
          fechaReunion: origen ? fechaReunion.get(origen) : undefined,
        };
      }),
    };
  }

  /**
   * Copia al historial los registros de otros módulos que todavía no estén
   * (upsert con `$setOnInsert`): una vez copiados quedan guardados aunque
   * después se borre el registro original. Sirve para un cliente o para todos.
   */
  private async sincronizar(estudioId: Types.ObjectId, clientesSync: ConFechas[]) {
    if (clientesSync.length === 0) return;
    const ids = clientesSync.map((c) => c._id);
    const filtro = { clienteId: { $in: ids }, estudioId };
    const [usuarios, extractos, reuniones, documentos, comunicados, facturas, vencimientos, avisos, tareas] =
      await Promise.all([
        this.userModel
          .find({ clienteId: { $in: ids } })
          .select('clienteId email createdAt esPrueba creadoPor')
          .lean()
          .exec(),
        this.extractoModel
          .find(filtro)
          .select('clienteId nombreArchivo periodo createdAt esPrueba creadoPor')
          .lean()
          .exec(),
        this.reunionModel
          .find(filtro)
          .select('clienteId titulo fecha creadoPor createdAt esPrueba')
          .lean()
          .exec(),
        this.documentoModel.find(filtro).select('clienteId nombre createdAt esPrueba creadoPor').lean().exec(),
        this.comunicadoModel.find(filtro).select('clienteId titulo createdAt esPrueba creadoPor').lean().exec(),
        this.facturaModel
          .find(filtro)
          .select('clienteId concepto monto numeroComprobante fechaEmision createdAt esPrueba creadoPor')
          .lean()
          .exec(),
        this.vencimientoModel.find(filtro).select('clienteId tipo fecha createdAt esPrueba creadoPor').lean().exec(),
        this.notificacionModel
          .find(filtro)
          .select('clienteId canal fechaEnvio estado esPrueba creadoPor')
          .lean()
          .exec(),
        this.tareaModel
          .find(filtro)
          .select('clienteId titulo jurisdiccion periodo creadoPor createdAt esPrueba')
          .lean()
          .exec(),
      ]);

    const eventos: EventoNuevo[] = [];
    const creado = (doc: { createdAt?: Date }) => doc.createdAt ?? new Date();
    // Registros creados desde la cuenta de pruebas: su evento de alta también se marca.
    const dePrueba = new Set(
      [...clientesSync, ...usuarios, ...extractos, ...reuniones, ...documentos, ...comunicados]
        .concat(facturas, vencimientos, avisos, tareas)
        .filter((doc) => (doc as ConFechas).esPrueba)
        .map((doc) => (doc as ConFechas)._id.toString()),
    );

    for (const cliente of clientesSync) {
      eventos.push({
        clienteId: cliente._id,
        tipo: TIPO_EVENTO.CLIENTE_CREADO,
        descripcion: 'Se dio de alta el cliente',
        fecha: creado(cliente),
        origenId: cliente._id,
        usuarioId: cliente.creadoPor,
      });
    }
    for (const u of usuarios as Array<ConCliente & { email?: string }>) {
      eventos.push({
        clienteId: u.clienteId,
        tipo: TIPO_EVENTO.USUARIO_PORTAL_CREADO,
        descripcion: `Se creó el usuario del portal${u.email ? ` (${u.email})` : ''}`,
        fecha: creado(u),
        origenId: u._id,
        usuarioId: u.creadoPor,
      });
    }
    for (const e of extractos as Array<ConCliente & { nombreArchivo: string; periodo: string }>) {
      eventos.push({
        clienteId: e.clienteId,
        tipo: TIPO_EVENTO.EXTRACTO_SUBIDO,
        descripcion: `Se generó el extracto "${e.nombreArchivo}" (período ${e.periodo})`,
        fecha: creado(e),
        origenId: e._id,
        usuarioId: e.creadoPor,
      });
    }
    for (const r of reuniones as Array<
      ConCliente & { titulo: string; fecha: Date; creadoPor?: Types.ObjectId }
    >) {
      eventos.push({
        clienteId: r.clienteId,
        tipo: TIPO_EVENTO.REUNION,
        descripcion: `Se creó la reunión "${r.titulo}" para el día ${fechaCorta(r.fecha)} a las ${horaCorta(r.fecha)} hs`,
        fecha: r.createdAt ?? r.fecha,
        origenId: r._id,
        usuarioId: r.creadoPor,
      });
    }
    for (const d of documentos as Array<ConCliente & { nombre: string }>) {
      eventos.push({
        clienteId: d.clienteId,
        tipo: TIPO_EVENTO.DOCUMENTO_SUBIDO,
        descripcion: `Se subió el documento "${d.nombre}"`,
        fecha: creado(d),
        origenId: d._id,
        usuarioId: d.creadoPor,
      });
    }
    for (const c of comunicados as Array<ConCliente & { titulo: string }>) {
      eventos.push({
        clienteId: c.clienteId,
        tipo: TIPO_EVENTO.COMUNICADO,
        descripcion: `Se le envió el comunicado "${c.titulo}"`,
        fecha: creado(c),
        origenId: c._id,
        usuarioId: c.creadoPor,
      });
    }
    for (const f of facturas as Array<
      ConCliente & { concepto: string; monto: number; numeroComprobante?: string; fechaEmision?: Date }
    >) {
      eventos.push({
        clienteId: f.clienteId,
        tipo: TIPO_EVENTO.FACTURA_CREADA,
        descripcion: `Se cargó la prefactura "${f.concepto}" por ${pesos(f.monto)}`,
        fecha: creado(f),
        origenId: f._id,
        usuarioId: f.creadoPor,
      });
      if (f.fechaEmision) {
        eventos.push({
          clienteId: f.clienteId,
          tipo: TIPO_EVENTO.FACTURA_EMITIDA,
          descripcion: `Se emitió la factura${f.numeroComprobante ? ` N° ${f.numeroComprobante}` : ''} por ${pesos(f.monto)}`,
          fecha: f.fechaEmision,
          origenId: f._id,
          usuarioId: f.creadoPor,
        });
      }
    }
    for (const v of vencimientos as Array<ConCliente & { tipo: string; fecha: Date }>) {
      eventos.push({
        clienteId: v.clienteId,
        tipo: TIPO_EVENTO.VENCIMIENTO_CARGADO,
        descripcion: `Se cargó el vencimiento "${v.tipo}" del ${fechaCorta(v.fecha)}`,
        fecha: creado(v),
        origenId: v._id,
        usuarioId: v.creadoPor,
      });
    }
    for (const a of avisos as Array<ConCliente & { canal: string; fechaEnvio: Date; estado: string }>) {
      eventos.push({
        clienteId: a.clienteId,
        tipo: TIPO_EVENTO.NOTIFICACION_ENVIADA,
        descripcion: `Se le envió un aviso de vencimiento por ${a.canal} (${a.estado})`,
        fecha: a.fechaEnvio,
        origenId: a._id,
        usuarioId: a.creadoPor,
      });
    }
    for (const t of tareas as Array<
      ConCliente & { titulo?: string; jurisdiccion?: string; periodo: string; creadoPor?: Types.ObjectId }
    >) {
      const nombre = t.titulo || [t.jurisdiccion, t.periodo].filter(Boolean).join(' ');
      eventos.push({
        clienteId: t.clienteId,
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

    // Eventos ya copiados antes sin quién: se completan en cuanto el origen lo tiene.
    const completarQuien: AnyBulkWriteOperation<ClienteEvento>[] = eventos
      .filter((e) => e.usuarioId && nombres.has(e.usuarioId.toString()))
      .map((e) => ({
        updateOne: {
          filter: { clienteId: e.clienteId, tipo: e.tipo, origenId: e.origenId, usuarioNombre: null },
          update: {
            $set: { usuarioId: e.usuarioId, usuarioNombre: nombres.get(e.usuarioId!.toString()) },
          },
        },
      }));
    const ops: AnyBulkWriteOperation<ClienteEvento>[] = eventos.map((e) => ({
      updateOne: {
        filter: { clienteId: e.clienteId, tipo: e.tipo, origenId: e.origenId },
        update: {
          $setOnInsert: {
            ...e,
            estudioId,
            usuarioNombre: e.usuarioId ? nombres.get(e.usuarioId.toString()) : undefined,
            ...(e.origenId && dePrueba.has(e.origenId.toString()) ? { esPrueba: true } : {}),
          },
        },
        upsert: true,
      },
    }));
    try {
      await this.eventoModel.bulkWrite([...ops, ...completarQuien], { ordered: false });
    } catch (err) {
      // Dos consultas simultáneas pueden chocar en el índice único: no es un problema real.
      this.logger.warn(`Sincronización parcial del historial: ${(err as Error).message}`);
    }
  }
}
