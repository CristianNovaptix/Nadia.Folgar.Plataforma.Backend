import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Cliente, ClienteDocument } from '../clientes/schemas/cliente.schema';
import {
  RegimenFiscalConfig,
  RegimenFiscalConfigDocument,
  correspondeAlMes,
} from '../regimenes-fiscales/schemas/regimen-fiscal-config.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { PaginatedResult } from '../common/dto/pagination-query.dto';
import {
  ChecklistItem,
  Etiqueta,
  EstadoTarea,
  Jurisdiccion,
  TareaPresentacion,
  TareaPresentacionDocument,
} from './schemas/tarea-presentacion.schema';
import { TareaAdjunto, TareaAdjuntoDocument } from './schemas/tarea-adjunto.schema';
import { CreateTareaPresentacionDto } from './dto/create-tarea-presentacion.dto';
import { UpdateTareaPresentacionDto } from './dto/update-tarea-presentacion.dto';
import { QueryTareaPresentacionDto } from './dto/query-tarea-presentacion.dto';
import { QueryKanbanDto } from './dto/query-kanban.dto';
import { MoverTareaDto } from './dto/mover-tarea.dto';
import { ChecklistItemDto } from './dto/checklist-item.dto';
import { EtiquetaDto } from './dto/etiqueta.dto';
import { CreateTareaAdjuntoDto } from './dto/create-tarea-adjunto.dto';
import { AnalizarDocumentoTareasDto } from './dto/analizar-documento-tareas.dto';
import { ImportarTareasDocumentoDto } from './dto/importar-tareas-documento.dto';
import { DocumentoTextoExtractorService } from './documento-texto-extractor.service';
import {
  AI_TAREAS_DOCUMENTO_PORT,
  AiTareasDocumentoPort,
  TareaPropuestaIA,
} from './ports/ai-tareas-documento.port';
import { ClienteHistorialService, TIPO_EVENTO } from '../clientes/cliente-historial.service';

/** Mismo nombre que usa el historial del cliente al registrar el alta de la tarea. */
function nombreTarea(tarea: { titulo?: string; jurisdiccion?: string; periodo?: string }): string {
  return tarea.titulo || [tarea.jurisdiccion, tarea.periodo].filter(Boolean).join(' ');
}

export interface GenerarTareasResultado {
  evaluados: number;
  creadas: number;
  omitidas: number;
}

/** Miembro asignable del tablero, tal como lo consume el picker del Frontend. */
export interface MiembroTablero {
  _id: string;
  nombre: string;
  /** `data:<contentType>;base64,<...>` listo para un <img src>, o null si no cargó foto. */
  avatarDataUrl: string | null;
}

/** Período fiscal actual en formato "YYYY-MM" (calendario de Buenos Aires, sin corrimiento de zona horaria relevante para este caso de uso). */
export function periodoActual(fecha: Date = new Date()): string {
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  return `${fecha.getFullYear()}-${mes}`;
}

/** Fecha (medianoche UTC, mismo formato que guarda el Frontend) del día `dia` del período "YYYY-MM", acotada al último día del mes. */
export function fechaDelPeriodo(periodo: string, dia: number): Date {
  const [anio, mes] = periodo.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return new Date(Date.UTC(anio, mes - 1, Math.min(dia, ultimoDia)));
}

function periodoSiguiente(periodo: string): string {
  const [anio, mes] = periodo.split('-').map(Number);
  return mes === 12 ? `${anio + 1}-01` : `${anio}-${String(mes + 1).padStart(2, '0')}`;
}

/** Un adjunto es "imagen" si su `contentType` viene con el prefijo MIME estándar `image/*`. */
function esImagen(contentType: string): boolean {
  return contentType.startsWith('image/');
}

/** Subconjunto de `TareaAdjunto` que alcanza para dibujar la portada de una tarjeta — sin `nombre`/`tamanioBytes`, que el Kanban no necesita. */
export interface PortadaAdjuntoResumen {
  contentType: string;
  contenidoBase64: string;
}

/**
 * `TareaPresentacion` tal como la devuelven `findKanban`/`findAllTareas`,
 * enriquecida con lo mínimo que la tarjeta necesita para mostrar el
 * adjunto de portada y el badge "📎 N" sin traer TODOS los adjuntos de
 * TODAS las tarjetas en cada listado — eso solo se pide bajo demanda con
 * `findAdjuntos`, cuando se abre una tarjeta puntual.
 */
export type TareaConAdjuntos = Record<string, unknown> & {
  adjuntosCount: number;
  portadaAdjunto: PortadaAdjuntoResumen | null;
};

@Injectable()
export class IvaTareasService {
  private readonly logger = new Logger(IvaTareasService.name);

  constructor(
    @InjectModel(TareaPresentacion.name)
    private readonly tareaModel: Model<TareaPresentacionDocument>,
    @InjectModel(TareaAdjunto.name)
    private readonly adjuntoModel: Model<TareaAdjuntoDocument>,
    @InjectModel(Cliente.name) private readonly clienteModel: Model<ClienteDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(RegimenFiscalConfig.name)
    private readonly regimenConfigModel: Model<RegimenFiscalConfigDocument>,
    private readonly documentoTextoExtractorService: DocumentoTextoExtractorService,
    @Inject(AI_TAREAS_DOCUMENTO_PORT)
    private readonly aiTareasDocumentoPort: AiTareasDocumentoPort,
    private readonly historial: ClienteHistorialService,
  ) {}

  /**
   * Usuarios internos (no de portal de clientes) que pueden aparecer en
   * "Asignar miembro/s"/"Asignado a" del Frontend — antes ese picker dependía
   * de listar `/users` (permiso `users.read`, que el rol "contador" no
   * tiene), así que quedaba degradado a "asignarme a mí". Este endpoint solo
   * pide `iva-tareas.read`, que sí tiene cualquiera que use el tablero.
   *
   * Deliberadamente NO filtra además por `iva-tareas.read` en el ROL de cada
   * usuario listado (a diferencia de una versión anterior de este método): todo
   * integrante de Personal tiene que poder aparecer acá, tenga o no ese
   * permiso puntual hoy — quién puede VER el tablero (para pedir este listado) es
   * un gate aparte, en el controller.
   *
   * Tampoco filtra por `estudioId` ni por `activo` — pedido explícito: "todo el
   * personal... deben verse siempre" en el filtro/asignación de tareas, mismo
   * universo de usuarios que ya trae "Personal" del Frontend (`GET /users`, sin
   * ninguno de esos dos filtros — ver `UsersService.findAll`). Con `estudioId` de
   * por medio, un integrante real de Personal quedaba afuera de este picker en
   * cuanto ese campo no coincidiera con el de quien lo estuviera pidiendo, aunque
   * siguiera viéndose bien en "Personal" (que nunca filtró por acá) — caso real
   * reportado, no hipotético.
   */
  async findMiembrosDelTablero(): Promise<MiembroTablero[]> {
    const usuarios = await this.userModel.find({ clienteId: { $exists: false } }).exec();

    return usuarios.map((usuario) => ({
      _id: usuario._id.toString(),
      nombre: usuario.nombre,
      avatarDataUrl:
        usuario.avatarContentType && usuario.avatarBase64
          ? `data:${usuario.avatarContentType};base64,${usuario.avatarBase64}`
          : null,
    }));
  }

  // ── Generación mensual automática ────────────────────────────────────

  /**
   * Genera, para `periodo` (default: mes en curso), una tarjeta por cada cliente activo ×
   * obligación cargada para su régimen fiscal en Seguridad → "Régimen fiscal"
   * (`RegimenFiscalConfig`). Un cliente sin régimen cargado, o con un régimen sin
   * obligaciones, no genera nada. El título de la tarjeta dice qué presentación hay que hacer.
   * No duplica: si ya existe una tarjeta con el mismo cliente+título+período, la omite.
   *
   * Si se pasa `estudioId` (disparo manual desde el controller) se limita a ese estudio; sin
   * `estudioId` (cron) corre sobre todos los estudios.
   */
  async generarTareasDelMes(
    periodo: string = periodoActual(),
    estudioId?: Types.ObjectId,
    /** Solo el cron lo pasa: omite las obligaciones cuyo `diaInicio` todavía no llegó. */
    diaDelMes?: number,
  ): Promise<GenerarTareasResultado> {
    const filtroClientes: FilterQuery<ClienteDocument> = { activo: true, regimenFiscal: { $exists: true, $ne: null } };
    if (estudioId) {
      filtroClientes.estudioId = estudioId;
    }

    const [clientes, configs] = await Promise.all([
      this.clienteModel.find(filtroClientes).exec(),
      this.regimenConfigModel.find(estudioId ? { estudioId } : {}).exec(),
    ]);

    const resultado: GenerarTareasResultado = { evaluados: 0, creadas: 0, omitidas: 0 };
    // Próxima posición libre en la columna "pendiente" por estudio, para no
    // pisar posiciones entre altas del mismo run (se inicializa lazy con el
    // conteo real en Mongo la primera vez que aparece cada estudio).
    const siguientePosicionPendiente = new Map<string, number>();
    const [anio, mes] = periodo.split('-');

    for (const cliente of clientes) {
      const obligaciones =
        configs.find(
          (c) => c.regimen === cliente.regimenFiscal && String(c.estudioId) === String(cliente.estudioId),
        )?.obligaciones ?? [];

      for (const obligacion of obligaciones) {
        const diaInicio = obligacion.diaInicio ?? 1;
        if (!correspondeAlMes(obligacion, Number(mes))) {
          continue;
        }
        if (diaDelMes !== undefined && diaDelMes < diaInicio) {
          continue;
        }
        resultado.evaluados += 1;
        const titulo = `Presentación: ${obligacion.nombre} — período ${mes}/${anio}`;

        const yaExiste = await this.tareaModel
          .exists({ estudioId: cliente.estudioId, clienteId: cliente._id, titulo, periodo })
          .exec();

        if (yaExiste) {
          resultado.omitidas += 1;
          continue;
        }

        const estudioKey = cliente.estudioId.toString();
        if (!siguientePosicionPendiente.has(estudioKey)) {
          const conteoActual = await this.tareaModel
            .countDocuments({ estudioId: cliente.estudioId, estado: EstadoTarea.PENDIENTE })
            .exec();
          siguientePosicionPendiente.set(estudioKey, conteoActual);
        }
        const posicion = siguientePosicionPendiente.get(estudioKey) ?? 0;
        siguientePosicionPendiente.set(estudioKey, posicion + 1);

        await this.tareaModel.create({
          clienteId: cliente._id,
          titulo,
          ...(obligacion.jurisdiccion ? { jurisdiccion: obligacion.jurisdiccion } : {}),
          periodo,
          fechaDesde: fechaDelPeriodo(periodo, diaInicio),
          ...(obligacion.diaVencimiento
            ? {
                fechaHasta: fechaDelPeriodo(
                  obligacion.diaVencimiento < diaInicio ? periodoSiguiente(periodo) : periodo,
                  obligacion.diaVencimiento,
                ),
              }
            : {}),
          estado: EstadoTarea.PENDIENTE,
          posicion,
          checklist: [],
          estudioId: cliente.estudioId,
        });
        resultado.creadas += 1;
      }
    }

    return resultado;
  }

  /**
   * Corre todos los días a la 1am: cada obligación se crea el día de inicio que tiene configurado
   * en "Régimen fiscal" (o después, si ese día no corrió) — la deduplicación evita repetirlas.
   */
  @Cron('0 1 * * *')
  async generarTareasDelMesCron(): Promise<void> {
    const hoy = new Date();
    const resultado = await this.generarTareasDelMes(periodoActual(hoy), undefined, hoy.getDate());
    this.logger.log(
      `generarTareasDelMes: evaluados=${resultado.evaluados} creadas=${resultado.creadas} ` +
        `omitidas=${resultado.omitidas}`,
    );
  }

  // ── Importar tareas desde documento ───────────────────────────────────

  /**
   * Análisis previo (no persiste nada): extrae el texto del documento
   * (determinístico) y se lo pasa a la IA para que proponga una lista de
   * tareas — el Frontend las muestra en el paso de revisión de
   * `ImportarTareasDialog` y recién se crean cuando el contador confirma con
   * `importarTareasDocumento`. Mismo espíritu que `analizarEncabezado` en
   * extractos-ia: no bloquea nada si falla, el contador puede seguir
   * completando a mano.
   */
  async analizarDocumento(
    dto: AnalizarDocumentoTareasDto,
  ): Promise<{ nombreArchivo: string; tareas: TareaPropuestaIA[] }> {
    const { texto, legible } = await this.documentoTextoExtractorService.extraer(
      dto.nombreArchivo,
      dto.contenidoBase64,
    );

    if (!legible) {
      throw new BadRequestException(
        'No se pudo leer texto de este documento (¿está vacío, escaneado, o es un formato no soportado?).',
      );
    }

    const resultado = await this.aiTareasDocumentoPort.analizarDocumento({
      nombreArchivo: dto.nombreArchivo,
      texto,
    });

    if (!resultado.exitoso) {
      throw new BadRequestException(resultado.mensaje ?? 'No se pudo analizar el documento.');
    }

    return { nombreArchivo: dto.nombreArchivo, tareas: resultado.tareas };
  }

  /**
   * Confirma la importación: crea una tarjeta por cada tarea del lote que el
   * contador dejó tildada en la revisión, todas en "Pendiente" para el mismo
   * cliente — sin jurisdicción (ver nota en el schema) y con `periodo` del
   * mes en curso, mismo criterio que `generarTareasDelMes`.
   */
  async importarTareasDocumento(
    dto: ImportarTareasDocumentoDto,
    estudioId: Types.ObjectId,
    creadoPor?: Types.ObjectId,
  ): Promise<{ creadas: number }> {
    const clienteExiste = await this.clienteModel.exists({ _id: dto.clienteId, estudioId }).exec();
    if (!clienteExiste) {
      throw new NotFoundException('Cliente no encontrado');
    }

    let posicion = await this.tareaModel
      .countDocuments({ estudioId, estado: EstadoTarea.PENDIENTE })
      .exec();

    let creadas = 0;
    for (const tarea of dto.tareas) {
      await this.tareaModel.create({
        clienteId: new Types.ObjectId(dto.clienteId),
        titulo: tarea.titulo,
        descripcion: tarea.descripcion,
        periodo: periodoActual(),
        estado: EstadoTarea.PENDIENTE,
        posicion: posicion++,
        checklist: (tarea.checklist ?? []).map((texto) => ({ texto, completado: false })),
        creadoPor,
        estudioId,
      });
      creadas += 1;
    }

    return { creadas };
  }

  // ── Kanban ──────────────────────────────────────────────────────────

  /**
   * Lista plana de todas las tareas del período pedido (default: mes en
   * curso), ordenada por estado+posición. El Frontend arma las 3 columnas
   * agrupando por `estado` — este método no devuelve la data ya agrupada
   * a propósito, para no acoplar el shape de la respuesta a un layout de
   * UI particular.
   */
  async findKanban(
    estudioId: Types.ObjectId,
    filtros: QueryKanbanDto,
  ): Promise<TareaConAdjuntos[]> {
    let periodo: FilterQuery<TareaPresentacionDocument>['periodo'] =
      filtros.periodo ?? periodoActual();
    if (filtros.periodoDesde || filtros.periodoHasta) {
      periodo = {
        ...(filtros.periodoDesde ? { $gte: filtros.periodoDesde } : {}),
        ...(filtros.periodoHasta ? { $lte: filtros.periodoHasta } : {}),
      };
    }

    const filter: FilterQuery<TareaPresentacionDocument> = {
      estudioId,
      periodo,
      enPapelera: { $ne: true },
    };
    if (filtros.jurisdiccion) {
      filter.jurisdiccion = filtros.jurisdiccion;
    }
    if (filtros.miembro) {
      // Igualdad simple sobre un campo array: Mongo la interpreta como
      // "el array contiene este valor" — no hace falta $elemMatch acá.
      filter.asignados = new Types.ObjectId(filtros.miembro);
    }

    const tareas = await this.tareaModel
      .find(filter)
      .sort({ estado: 1, posicion: 1 })
      .populate('clienteId', 'nombre cuit regimenFiscal')
      .populate('asignados', 'nombre email')
      .populate('creadoPor', 'nombre')
      .exec();

    return this.enriquecerConAdjuntos(tareas);
  }

  /** Tarjetas en la papelera del tablero, de cualquier período — compartida por todo el estudio. */
  async findPapelera(estudioId: Types.ObjectId): Promise<TareaConAdjuntos[]> {
    const tareas = await this.tareaModel
      .find({ estudioId, enPapelera: true })
      .sort({ updatedAt: -1 })
      .populate('clienteId', 'nombre cuit regimenFiscal')
      .populate('asignados', 'nombre email')
      .populate('creadoPor', 'nombre')
      .exec();
    return this.enriquecerConAdjuntos(tareas);
  }

  /**
   * Tarjetas no presentadas, de cualquier período, ya vencidas o que vencen
   * dentro de `horas` — base de la campanita del Inicio (ver `AlertasTareasService`).
   */
  async findAlertasVencimiento(
    estudioId: Types.ObjectId,
    horas: number,
    ahora: Date = new Date(),
  ): Promise<TareaPresentacionDocument[]> {
    const limite = new Date(ahora.getTime() + horas * 60 * 60 * 1000);
    return this.tareaModel
      .find({
        estudioId,
        enPapelera: { $ne: true },
        estado: { $ne: EstadoTarea.PRESENTADO },
        fechaHasta: { $ne: null, $lte: limite },
      })
      .sort({ fechaHasta: 1 })
      .populate('clienteId', 'nombre cuit')
      .exec();
  }

  /**
   * Agrega `adjuntosCount` y `portadaAdjunto` (el contenido del adjunto de
   * portada nada más, no de todos) a cada tarea de un listado — usado tanto
   * por `findKanban` como por `findAllTareas` para que la tarjeta pueda
   * mostrar el badge "📎 N" y la imagen de portada sin que el listado
   * entero cargue el contenido de CADA adjunto de CADA tarjeta.
   */
  private async enriquecerConAdjuntos(
    tareas: TareaPresentacionDocument[],
  ): Promise<TareaConAdjuntos[]> {
    if (tareas.length === 0) return [];

    const ids = tareas.map((tarea) => tarea._id);
    const conteos = await this.adjuntoModel
      .aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { tareaId: { $in: ids } } },
        { $group: { _id: '$tareaId', count: { $sum: 1 } } },
      ])
      .exec();
    const conteoPorTarea = new Map(conteos.map((c) => [c._id.toString(), c.count]));

    const idsPortada = tareas
      .map((tarea) => tarea.portadaAdjuntoId)
      .filter((id): id is Types.ObjectId => !!id);
    const portadas = idsPortada.length
      ? await this.adjuntoModel
          .find({ _id: { $in: idsPortada } }, 'contentType contenidoBase64')
          .exec()
      : [];
    const portadaPorId = new Map(portadas.map((p) => [p._id.toString(), p]));

    return tareas.map((tarea) => {
      const portada = tarea.portadaAdjuntoId
        ? portadaPorId.get(tarea.portadaAdjuntoId.toString())
        : undefined;

      return {
        ...(tarea.toObject() as unknown as Record<string, unknown>),
        adjuntosCount: conteoPorTarea.get(tarea._id.toString()) ?? 0,
        portadaAdjunto: portada
          ? { contentType: portada.contentType, contenidoBase64: portada.contenidoBase64 }
          : null,
      };
    });
  }

  /**
   * Mueve una tarea a otro estado/posición — lo que el drag & drop del
   * tablero llama al soltar una tarjeta. Reordena de forma simple (no
   * sofisticada): renumera la columna de origen si cambió de columna, y
   * renumera la columna de destino insertando la tarea en el índice pedido.
   */
  async moverTarea(
    id: string,
    dto: MoverTareaDto,
    estudioId: Types.ObjectId,
  ): Promise<TareaPresentacionDocument> {
    const tarea = await this.findOneTarea(id, estudioId);
    const estadoAnterior = tarea.estado;

    if (estadoAnterior !== dto.estado) {
      const restantesOrigen = await this.tareaModel
        .find({ estudioId, estado: estadoAnterior, _id: { $ne: tarea._id } })
        .sort({ posicion: 1 })
        .exec();

      await Promise.all(
        restantesOrigen.map((t, index) =>
          t.posicion === index
            ? Promise.resolve()
            : this.tareaModel.updateOne({ _id: t._id }, { posicion: index }).exec(),
        ),
      );
    }

    // Se trabaja solo con los `_id` de la columna destino (no con los
    // documentos completos): mezclar el documento `tarea` con los que
    // devuelve `.find().exec()` en el mismo array rompe la inferencia de
    // tipos de Mongoose (el `HydratedDocument` queda envuelto dos veces).
    const idsColumnaDestino = (
      await this.tareaModel
        .find({ estudioId, estado: dto.estado, _id: { $ne: tarea._id } })
        .sort({ posicion: 1 })
        .exec()
    ).map((t) => t._id);

    const indiceInsercion = Math.max(0, Math.min(dto.posicion, idsColumnaDestino.length));
    idsColumnaDestino.splice(indiceInsercion, 0, tarea._id);

    await Promise.all(
      idsColumnaDestino.map((tareaId, index) =>
        tareaId.equals(tarea._id)
          ? Promise.resolve()
          : this.tareaModel.updateOne({ _id: tareaId }, { posicion: index }).exec(),
      ),
    );

    tarea.estado = dto.estado;
    tarea.posicion = indiceInsercion;
    await tarea.save();

    return tarea;
  }

  /** `completado` es opcional en el DTO (default false) pero requerido en el subdocumento Mongoose. */
  private mapChecklist(items?: ChecklistItemDto[]): ChecklistItem[] {
    return (items ?? []).map((item) => ({
      texto: item.texto,
      completado: item.completado ?? false,
    }));
  }

  private mapEtiquetas(items?: EtiquetaDto[]): Etiqueta[] {
    return (items ?? []).map((item) => ({ texto: item.texto, color: item.color }));
  }

  // ── CRUD paginado ───────────────────────────────────────────────────

  async findAllTareas(
    query: QueryTareaPresentacionDto,
    estudioId: Types.ObjectId,
  ): Promise<PaginatedResult<TareaConAdjuntos>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const filter: FilterQuery<TareaPresentacionDocument> = {
      estudioId,
      enPapelera: { $ne: true },
    };

    if (query.jurisdiccion) {
      filter.jurisdiccion = query.jurisdiccion;
    }
    if (query.estado) {
      filter.estado = query.estado;
    }
    if (query.miembro) {
      filter.asignados = new Types.ObjectId(query.miembro);
    }
    if (query.clienteId) {
      filter.clienteId = new Types.ObjectId(query.clienteId);
    }
    if (query.periodo) {
      filter.periodo = query.periodo;
    }

    const sort: Record<string, 1 | -1> = query.sortBy
      ? { [query.sortBy]: query.sortDir === 'desc' ? -1 : 1 }
      : { periodo: -1, estado: 1, posicion: 1 };

    const [data, total] = await Promise.all([
      this.tareaModel
        .find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('clienteId', 'nombre cuit regimenFiscal')
        .populate('asignados', 'nombre email')
        .populate('creadoPor', 'nombre')
        .exec(),
      this.tareaModel.countDocuments(filter).exec(),
    ]);

    return { data: await this.enriquecerConAdjuntos(data), total, page, limit };
  }

  async findOneTarea(id: string, estudioId: Types.ObjectId): Promise<TareaPresentacionDocument> {
    const tarea = await this.tareaModel.findOne({ _id: id, estudioId }).exec();
    if (!tarea) {
      throw new NotFoundException('Tarea de presentación no encontrada');
    }
    return tarea;
  }

  async createTarea(
    dto: CreateTareaPresentacionDto,
    estudioId: Types.ObjectId,
    creadoPor?: Types.ObjectId,
  ): Promise<TareaPresentacionDocument> {
    const estado = dto.estado ?? EstadoTarea.PENDIENTE;
    const posicion = await this.tareaModel.countDocuments({ estudioId, estado }).exec();

    return this.tareaModel.create({
      clienteId: new Types.ObjectId(dto.clienteId),
      jurisdiccion: dto.jurisdiccion,
      periodo: dto.periodo,
      fechaDesde: dto.fechaDesde ? new Date(dto.fechaDesde) : undefined,
      fechaHasta: dto.fechaHasta ? new Date(dto.fechaHasta) : undefined,
      estado,
      posicion,
      asignados: (dto.asignados ?? []).map((id) => new Types.ObjectId(id)),
      descripcion: dto.descripcion,
      checklist: this.mapChecklist(dto.checklist),
      prioridad: dto.prioridad,
      etiquetas: this.mapEtiquetas(dto.etiquetas),
      portadaColor: dto.portadaColor,
      titulo: dto.titulo,
      creadoPor,
      estudioId,
    });
  }

  /**
   * Edición de checklist/asignación/cliente/jurisdicción/período.
   * Deliberadamente NO toca `estado` ni `posicion` — esos dos campos son
   * las columnas y el orden del Kanban, y cambiarlos fuera de `moverTarea`
   * rompería la numeración consistente de la columna. Si en el futuro hace
   * falta permitir ese cambio desde este endpoint, tiene que reusar la
   * misma lógica de reordenamiento.
   */
  async updateTarea(
    id: string,
    dto: UpdateTareaPresentacionDto,
    estudioId: Types.ObjectId,
    usuarioId?: string,
  ): Promise<TareaPresentacionDocument> {
    const tarea = await this.findOneTarea(id, estudioId);

    if (dto.clienteId) {
      tarea.clienteId = new Types.ObjectId(dto.clienteId);
    }
    // Acepta `null` explícito para "quitar" (destildar la etiqueta ARCA/ARBA/AGIP sin elegir
    // otra) — mismo criterio que `prioridad`/`portadaColor` más abajo.
    if (dto.jurisdiccion !== undefined) {
      tarea.jurisdiccion = dto.jurisdiccion ?? undefined;
    }
    if (dto.periodo) {
      tarea.periodo = dto.periodo;
    }
    if (dto.fechaDesde !== undefined) {
      tarea.fechaDesde = dto.fechaDesde ? new Date(dto.fechaDesde) : undefined;
    }
    if (dto.fechaHasta !== undefined) {
      tarea.fechaHasta = dto.fechaHasta ? new Date(dto.fechaHasta) : undefined;
    }
    if (dto.asignados) {
      tarea.asignados = dto.asignados.map((id) => new Types.ObjectId(id));
    }
    // A diferencia de `prioridad`/`portadaColor`, acá no hace falta el truco de
    // `null`: `@IsString()` ya deja pasar `''` sin problema, así que un string
    // vacío alcanza para "borrar" la descripción.
    if (dto.descripcion !== undefined) {
      tarea.descripcion = dto.descripcion || undefined;
    }
    if (dto.checklist) {
      tarea.checklist = this.mapChecklist(dto.checklist);
    }
    // `prioridad`/`portadaColor` aceptan `null` explícito para "quitar":
    // `@IsOptional()` en el DTO deja pasar `null` sin correr `@IsEnum`/`@Matches`,
    // y acá se traduce a `undefined` de Mongo.
    if (dto.prioridad !== undefined) {
      tarea.prioridad = dto.prioridad ?? undefined;
    }
    if (dto.etiquetas) {
      tarea.etiquetas = this.mapEtiquetas(dto.etiquetas);
    }
    if (dto.portadaColor !== undefined) {
      tarea.portadaColor = dto.portadaColor ?? undefined;
    }
    // Igual criterio que `descripcion`: un string vacío alcanza para "borrarlo", no hace
    // falta el truco de `null`. Solo lo usan las tarjetas importadas desde documento — el
    // lápiz de `KanbanCard` las edita a través de acá.
    if (dto.titulo !== undefined) {
      tarea.titulo = dto.titulo || undefined;
    }
    if (dto.enPapelera !== undefined) {
      if (Boolean(tarea.enPapelera) !== dto.enPapelera) {
        await this.historial.registrarCambioDeOrigen(
          tarea.clienteId,
          estudioId,
          dto.enPapelera ? TIPO_EVENTO.REGISTRO_PAPELERA : TIPO_EVENTO.REGISTRO_RESTAURADO,
          dto.enPapelera
            ? `Se mandó a la papelera la tarea "${nombreTarea(tarea)}"`
            : `Se restauró la tarea "${nombreTarea(tarea)}"`,
          usuarioId,
        );
      }
      tarea.enPapelera = dto.enPapelera;
    }

    await tarea.save();
    return tarea;
  }

  /**
   * Borrado real de una tarea de presentación (a diferencia de `Cliente`, que
   * se desactiva — acá no hay un concepto de "tarea inactiva" que tenga
   * sentido para el equipo, y el Frontend la ofrece desde el menú rápido de
   * la tarjeta). Renumera la columna de origen igual que la mitad
   * "columna de origen" de `moverTarea`, para no dejar huecos en `posicion`.
   */
  async removeTarea(id: string, estudioId: Types.ObjectId, usuarioId?: string): Promise<void> {
    const tarea = await this.findOneTarea(id, estudioId);
    await this.historial.registrarCambioDeOrigen(
      tarea.clienteId,
      estudioId,
      TIPO_EVENTO.REGISTRO_ELIMINADO,
      `Se eliminó definitivamente la tarea "${nombreTarea(tarea)}"`,
      usuarioId,
    );

    await this.tareaModel.deleteOne({ _id: tarea._id }).exec();
    // Sin esto quedarían adjuntos huérfanos en Mongo (la tarea que los
    // referenciaba ya no existe, y nada más los va a buscar ni a limpiar).
    await this.adjuntoModel.deleteMany({ tareaId: tarea._id, estudioId }).exec();

    const restantes = await this.tareaModel
      .find({ estudioId, estado: tarea.estado })
      .sort({ posicion: 1 })
      .exec();

    await Promise.all(
      restantes.map((t, index) =>
        t.posicion === index
          ? Promise.resolve()
          : this.tareaModel.updateOne({ _id: t._id }, { posicion: index }).exec(),
      ),
    );
  }

  // ── Adjuntos ────────────────────────────────────────────────────────

  /** Listado completo (con contenido) de los adjuntos de una tarjeta — se pide bajo demanda al abrirla, nunca en el listado del Kanban. */
  async findAdjuntos(tareaId: string, estudioId: Types.ObjectId): Promise<TareaAdjuntoDocument[]> {
    // Las dos consultas van en paralelo (cada ida y vuelta a la base suma demora al abrir la tarjeta);
    // `findOneTarea` igual valida que la tarea exista y sea de este estudio antes de devolver nada.
    const [, adjuntos] = await Promise.all([
      this.findOneTarea(tareaId, estudioId),
      this.adjuntoModel
        .find({ tareaId: new Types.ObjectId(tareaId), estudioId })
        .sort({ createdAt: -1 })
        .populate('subidoPor', 'nombre')
        .exec(),
    ]);
    return adjuntos;
  }

  /**
   * Sube un adjunto (drag&drop, selector de archivo, pegado desde
   * portapapeles — todo llega acá igual, ya convertido a base64 por el
   * Frontend). Si es una imagen, pasa a ser la portada de la tarjeta
   * automáticamente: no hace falta un paso manual de "usar como portada"
   * (pedido explícito — "si es imagen debe aparecer en la tarjeta"),
   * reemplazando tanto una portada de color como una portada de imagen
   * anterior. Los adjuntos que no son imagen nunca tocan la portada.
   */
  async addAdjunto(
    tareaId: string,
    dto: CreateTareaAdjuntoDto,
    estudioId: Types.ObjectId,
    subidoPor?: Types.ObjectId,
  ): Promise<TareaAdjuntoDocument> {
    const tarea = await this.findOneTarea(tareaId, estudioId);

    const adjunto = await this.adjuntoModel.create({
      tareaId: tarea._id,
      nombre: dto.nombre,
      contentType: dto.contentType,
      contenidoBase64: dto.contenidoBase64,
      tamanioBytes: dto.tamanioBytes,
      subidoPor,
      estudioId,
    });

    if (esImagen(dto.contentType)) {
      tarea.portadaAdjuntoId = adjunto._id;
      tarea.portadaColor = undefined;
      await tarea.save();
    }

    return adjunto;
  }

  /**
   * Borra un adjunto puntual; si era la portada de la tarjeta, pasa a serlo la imagen más reciente
   * que quede (pedido explícito: borrar la primera foto no debe dejar la tarjeta sin imagen). Sin
   * otra imagen, la tarjeta queda sin portada. Devuelve la portada vigente para que el Frontend la
   * refleje sin volver a pedir el tablero.
   */
  async removeAdjunto(
    tareaId: string,
    adjuntoId: string,
    estudioId: Types.ObjectId,
  ): Promise<{ portadaAdjunto: { _id: string; contentType: string; contenidoBase64: string } | null }> {
    const tarea = await this.findOneTarea(tareaId, estudioId);

    const adjunto = await this.adjuntoModel
      .findOne({ _id: adjuntoId, tareaId: tarea._id, estudioId })
      .exec();
    if (!adjunto) {
      throw new NotFoundException('Adjunto no encontrado');
    }

    await adjunto.deleteOne();

    if (!tarea.portadaAdjuntoId?.equals(adjunto._id)) {
      const actual = tarea.portadaAdjuntoId
        ? await this.adjuntoModel.findOne({ _id: tarea.portadaAdjuntoId, estudioId }).exec()
        : null;
      return {
        portadaAdjunto: actual
          ? { _id: actual._id.toString(), contentType: actual.contentType, contenidoBase64: actual.contenidoBase64 }
          : null,
      };
    }

    const restantes = await this.adjuntoModel
      .find({ tareaId: tarea._id, estudioId })
      .sort({ createdAt: -1 })
      .exec();
    const siguiente = restantes.find((a) => esImagen(a.contentType));
    tarea.portadaAdjuntoId = siguiente?._id;
    await tarea.save();
    return {
      portadaAdjunto: siguiente
        ? { _id: siguiente._id.toString(), contentType: siguiente.contentType, contenidoBase64: siguiente.contenidoBase64 }
        : null,
    };
  }
}
