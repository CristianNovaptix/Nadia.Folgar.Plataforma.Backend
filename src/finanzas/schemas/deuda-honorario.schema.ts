import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type DeudaHonorarioDocument = HydratedDocument<DeudaHonorario>;

export enum EstadoDeuda {
  PENDIENTE = 'pendiente',
  PARCIAL = 'parcial',
  PAGADA = 'pagada',
}

export enum MedioPago {
  TRANSFERENCIA = 'transferencia',
  EFECTIVO = 'efectivo',
  CHEQUE = 'cheque',
  MERCADO_PAGO = 'mercado_pago',
  OTRO = 'otro',
}

/**
 * Un pago (total o parcial) de la deuda de un mes. Nunca se borra: si se
 * cargó mal se anula, y queda guardado quién lo anuló, cuándo y por qué.
 */
@Schema()
export class PagoHonorario {
  _id: Types.ObjectId;

  @Prop({ required: true, min: 0.01 })
  monto: number;

  /** Fecha en que el cliente pagó (puede ser anterior al día en que se carga). */
  @Prop({ required: true })
  fecha: Date;

  @Prop({ type: String, enum: MedioPago, default: MedioPago.TRANSFERENCIA })
  medio: MedioPago;

  @Prop({ trim: true })
  nota?: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  registradoPor?: Types.ObjectId;

  @Prop({ trim: true })
  registradoPorNombre?: string;

  @Prop({ default: false })
  anulado: boolean;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  anuladoPor?: Types.ObjectId;

  @Prop({ trim: true })
  anuladoPorNombre?: string;

  @Prop()
  anuladoEn?: Date;

  @Prop({ trim: true })
  motivoAnulacion?: string;

  /** Cuándo se cargó el pago en la plataforma. */
  @Prop({ required: true })
  registradoEn: Date;
}

export const PagoHonorarioSchema = SchemaFactory.createForClass(PagoHonorario);

/**
 * Lo que un cliente debe de honorarios por un mes. Se genera sola el día 1
 * con el abono vigente en ese momento (queda copiado acá: cambiar el abono
 * después no modifica las deudas ya generadas). Una sola por cliente y mes.
 */
@Schema(baseSchemaOptions)
export class DeudaHonorario {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Cliente', required: true, index: true })
  clienteId: Types.ObjectId;

  /** Mes de la deuda, formato AAAA-MM. */
  @Prop({ required: true })
  periodo: string;

  @Prop({ required: true, min: 0 })
  monto: number;

  /** Suma de los pagos no anulados. */
  @Prop({ required: true, min: 0, default: 0 })
  pagado: number;

  @Prop({ type: String, enum: EstadoDeuda, default: EstadoDeuda.PENDIENTE })
  estado: EstadoDeuda;

  @Prop({ type: [PagoHonorarioSchema], default: [] })
  pagos: PagoHonorario[];

  /** Desde cuándo corre el plazo de pago de esta deuda. */
  @Prop()
  fechaInicioPago?: Date;

  /**
   * Hasta cuándo se puede pagar sin estar vencida. Se calcula al generarse con
   * el día de vencimiento del cliente y después se puede correr a mano.
   */
  @Prop()
  fechaVencimiento?: Date;

  /** Cuándo terminó de pagarse. */
  @Prop()
  fechaCompletada?: Date;

  /** Quién facturaba y qué día se emitía al generarse esta deuda. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  facturadorId?: Types.ObjectId;

  @Prop({ min: 1, max: 31 })
  diaEmision?: number;

  /** `automatica` = la generó el sistema el día 1; `manual` = alguien la generó con el botón. */
  @Prop({ type: String, enum: ['automatica', 'manual'], default: 'automatica' })
  origen: 'automatica' | 'manual';

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const DeudaHonorarioSchema = SchemaFactory.createForClass(DeudaHonorario);
DeudaHonorarioSchema.index({ estudioId: 1, clienteId: 1, periodo: 1 }, { unique: true });
DeudaHonorarioSchema.index({ estudioId: 1, periodo: 1 });
