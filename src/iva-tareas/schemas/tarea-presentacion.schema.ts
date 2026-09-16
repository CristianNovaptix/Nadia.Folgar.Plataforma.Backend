import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type TareaPresentacionDocument = HydratedDocument<TareaPresentacion>;

/** Jurisdicción/organismo ante el que se presenta la obligación. */
export enum Jurisdiccion {
  ARCA = 'ARCA',
  ARBA = 'ARBA',
  AGIP = 'AGIP',
}

/** Estado de la tarea — son, literalmente, las 3 columnas del tablero Kanban. */
export enum EstadoTarea {
  PENDIENTE = 'pendiente',
  EN_CURSO = 'en_curso',
  PRESENTADO = 'presentado',
}

/** Urgencia declarada a mano por el equipo — no se calcula, es una etiqueta más. */
export enum Prioridad {
  BAJA = 'baja',
  MEDIA = 'media',
  ALTA = 'alta',
}

/**
 * Ítem del checklist de una presentación (ej. "Conciliar IVA Ventas", "Subir
 * a ARCA", "Avisar al cliente"). No hay catálogo de checklists por
 * jurisdicción todavía (eso es FOLGAR-048, pendiente de relevar con Nadia) —
 * `checklist` arranca vacío al generar la tarea y el equipo carga los ítems
 * a mano desde el Frontend.
 */
@Schema({ _id: true })
export class ChecklistItem {
  @Prop({ required: true, trim: true })
  texto: string;

  @Prop({ default: false })
  completado: boolean;
}

export const ChecklistItemSchema = SchemaFactory.createForClass(ChecklistItem);

/**
 * Etiqueta libre tipo Trello (texto + color hex) — sin catálogo fijo por el
 * mismo motivo que `ChecklistItem`: no hay un set de etiquetas acordado con
 * Nadia todavía, así que el equipo las crea a mano desde el Frontend.
 */
@Schema({ _id: false })
export class Etiqueta {
  @Prop({ required: true, trim: true })
  texto: string;

  /** Hex de 6 dígitos, ej. "#96602f". Validado en el DTO, no acá. */
  @Prop({ required: true, trim: true })
  color: string;
}

export const EtiquetaSchema = SchemaFactory.createForClass(Etiqueta);

/**
 * Tarea de presentación de un cliente ante una jurisdicción para un período
 * (`"YYYY-MM"`), generada automáticamente todos los meses por
 * `IvaTareasService.generarTareasDelMes()` (ver ese servicio para el criterio
 * de qué jurisdicciones aplican según `regimenFiscal`).
 *
 * `posicion` es el mismo concepto que `position` en el Kanban del CRM de
 * Novaptix: el orden relativo de la tarjeta dentro de su columna (`estado`).
 * Se recalcula de forma simple en `moverTarea` (no hace falta ser
 * sofisticado — ver comentario en el service).
 */
@Schema(baseSchemaOptions)
export class TareaPresentacion {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Cliente', required: true, index: true })
  clienteId: Types.ObjectId;

  /**
   * Opcional: las tareas de "Importar tareas desde documento" (checklist
   * FOLGAR-051-bis) no corresponden a una presentación puntual ante un
   * organismo, así que no tienen jurisdicción — ver `titulo` en esta misma
   * clase, que es lo que identifica a esas tarjetas en su lugar.
   */
  @Prop({ type: String, enum: Jurisdiccion, required: false })
  jurisdiccion?: Jurisdiccion;

  /**
   * Período fiscal de la presentación, formato "YYYY-MM" (ej. "2026-07") —
   * sigue siendo el campo que usan `findKanban`/`generarTareasDelMes`/el
   * dashboard para agrupar por mes. Ya no lo elige el usuario a mano: el
   * Frontend lo deriva de `fechaHasta` (o `fechaDesde` si no hay hasta) al
   * guardar el vencimiento, o cae al mes en curso si la tarjeta no tiene
   * ninguna de las dos fechas cargada.
   */
  @Prop({ required: true, trim: true })
  periodo: string;

  /**
   * Vencimiento de la tarjeta (equivalente a "Fechas" de Trello): rango
   * opcional `fechaDesde`/`fechaHasta` que reemplaza al viejo selector de
   * "Período" como único campo de fecha editable a mano. Ambas son
   * independientes de `periodo` (que sigue existiendo solo como campo
   * derivado interno, ver arriba) — una tarjeta puede no tener ninguna de
   * las dos cargada.
   */
  @Prop({ type: Date, required: false })
  fechaDesde?: Date;

  @Prop({ type: Date, required: false })
  fechaHasta?: Date;

  @Prop({ type: String, enum: EstadoTarea, default: EstadoTarea.PENDIENTE })
  estado: EstadoTarea;

  /** Orden dentro de la columna (`estado`). Mismo concepto que `position` en el Kanban del CRM. */
  @Prop({ default: 0 })
  posicion: number;

  /**
   * Colaboradoras asignadas a la tarea (0 a N, como los "miembros" de una
   * tarjeta de Trello). Arranca vacío: se puede generar sin asignar y
   * repartir después.
   */
  @Prop({ type: [Types.ObjectId], ref: 'User', default: [] })
  asignados: Types.ObjectId[];

  /** Texto libre tipo "descripción" de Trello — detalle de la presentación, notas para quien la retome, etc. */
  @Prop({ required: false, trim: true })
  descripcion?: string;

  @Prop({ type: [ChecklistItemSchema], default: [] })
  checklist: ChecklistItem[];

  @Prop({ type: String, enum: Prioridad, required: false })
  prioridad?: Prioridad;

  @Prop({ type: [EtiquetaSchema], default: [] })
  etiquetas: Etiqueta[];

  /**
   * Color de portada de la tarjeta (hex), equivalente simplificado a la
   * "cover" de Trello sin imagen — se usa cuando la tarjeta no tiene ningún
   * adjunto de imagen (`portadaAdjuntoId`), que tiene prioridad visual sobre
   * este color cuando está presente (ver `IvaTareasService.addAdjunto`).
   */
  @Prop({ required: false, trim: true })
  portadaColor?: string;

  /**
   * Adjunto de imagen que se muestra como portada de la tarjeta (ver
   * `TareaAdjunto`) — se setea/limpia solo, nunca a mano: `addAdjunto` lo
   * apunta al último adjunto de imagen subido/pegado, y `removeAdjunto` lo
   * limpia si se borra justo ese adjunto. No convive con elegir una portada
   * de imagen distinta a mano todavía (fuera de alcance, ver CLAUDE.md).
   */
  @Prop({ type: Types.ObjectId, ref: 'TareaAdjunto', required: false })
  portadaAdjuntoId?: Types.ObjectId;

  /**
   * Título propio de la tarjeta — solo lo traen las tareas importadas desde
   * documento (ej. "Analizar el concepto de ética y moral"). El resto de las
   * tareas (generadas por `generarTareasDelMes` o alta manual) no lo tiene:
   * su encabezado en el Frontend es el nombre del cliente.
   */
  @Prop({ required: false, trim: true, maxlength: 300 })
  titulo?: string;

  /**
   * Quién dio de alta la tarjeta (manual o "Importar tareas desde
   * documento") — a diferencia de `TareaAdjunto.subidoPor`, este campo no
   * existía hasta ahora, así que las tarjetas creadas antes de este cambio
   * quedan sin creador (`undefined`), no con uno inventado. Las tarjetas que
   * salen de `generarTareasDelMes` (alta automática recurrente, cron o
   * disparo manual sin un usuario puntual detrás del alta) tampoco lo
   * llevan — no hay una persona real a la que atribuírselo.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', required: false })
  creadoPor?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const TareaPresentacionSchema = SchemaFactory.createForClass(TareaPresentacion);

/**
 * Índice compuesto que respalda tanto la consulta principal del Kanban
 * (`estudioId` + `periodo`) como la deduplicación de `generarTareasDelMes`
 * (`estudioId` + `periodo` + `jurisdiccion` + `clienteId` es la clave lógica
 * de "una tarea por cliente+jurisdicción+período").
 */
TareaPresentacionSchema.index({ estudioId: 1, periodo: 1, jurisdiccion: 1 });
TareaPresentacionSchema.index({ estudioId: 1, periodo: 1, clienteId: 1, jurisdiccion: 1 });
