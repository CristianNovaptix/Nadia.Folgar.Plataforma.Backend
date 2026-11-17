import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type HonorarioConfigDocument = HydratedDocument<HonorarioConfig>;

/**
 * Plata que el cliente pagó de más o por adelantado: queda "a favor" y se
 * descuenta sola de las próximas deudas. `disponible` es lo que todavía no
 * se usó. Nunca se borra: si se cargó mal, se anula con motivo.
 */
@Schema()
export class AdelantoHonorario {
  _id: Types.ObjectId;

  @Prop({ required: true, min: 0.01 })
  monto: number;

  @Prop({ required: true, min: 0 })
  disponible: number;

  @Prop({ required: true })
  fecha: Date;

  /**
   * Mes ("AAAA-MM") para el que se pagó por adelantado: no se descuenta de
   * deudas de meses anteriores a ese. Sin cargar = se usa en la próxima deuda.
   */
  @Prop()
  periodo?: string;

  @Prop({ type: String, default: 'transferencia' })
  medio: string;

  @Prop({ trim: true })
  nota?: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  registradoPor?: Types.ObjectId;

  @Prop({ trim: true })
  registradoPorNombre?: string;

  @Prop({ required: true })
  registradoEn: Date;

  @Prop({ default: false })
  anulado: boolean;

  /** Cuánto quedaba sin usar cuando se anuló. */
  @Prop()
  montoAnulado?: number;

  @Prop({ trim: true })
  anuladoPorNombre?: string;

  @Prop()
  anuladoEn?: Date;

  @Prop({ trim: true })
  motivoAnulacion?: string;
}

export const AdelantoHonorarioSchema = SchemaFactory.createForClass(AdelantoHonorario);

/**
 * Cuánto se le cobra por mes a un cliente ("abono"), quién le factura y qué
 * día del mes se emite la factura. Una sola por cliente. El abono vale para
 * todos los meses siguientes hasta que se vuelva a editar; cada cambio queda
 * además en `AbonoCambio`.
 */
@Schema(baseSchemaOptions)
export class HonorarioConfig {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Cliente', required: true })
  clienteId: Types.ObjectId;

  @Prop({ required: true, min: 0, default: 0 })
  abono: number;

  /**
   * Desde cuándo el cliente tiene un abono mayor a cero. La deuda automática
   * de un mes solo se genera si el abono ya existía antes de empezar ese mes:
   * así, cargar un abono a mitad de mes no crea una deuda sorpresa esa noche.
   */
  @Prop()
  abonoDesde?: Date;

  /** Integrante de Personal que le factura a este cliente. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  facturadorId?: Types.ObjectId;

  /** Día del mes (1-31) en que se emite la factura. */
  @Prop({ min: 1, max: 31 })
  diaEmision?: number;

  /** Día del mes (1-31) desde el que el cliente paga. Sin cargar = `DIA_INICIO_PAGO_DEFECTO` (1). */
  @Prop({ min: 1, max: 31 })
  diaInicioPago?: number;

  /**
   * Día del mes (1-31) hasta el que el cliente puede pagar la deuda de ese mes
   * sin estar vencido. Sin cargar = `DIA_VENCIMIENTO_DEFECTO` (10).
   */
  @Prop({ min: 1, max: 31 })
  diaVencimiento?: number;

  /** Pagos adelantados / saldo a favor del cliente. */
  @Prop({ type: [AdelantoHonorarioSchema], default: [] })
  adelantos: AdelantoHonorario[];

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const HonorarioConfigSchema = SchemaFactory.createForClass(HonorarioConfig);
HonorarioConfigSchema.index({ estudioId: 1, clienteId: 1 }, { unique: true });
