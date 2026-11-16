import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type AbonoCambioDocument = HydratedDocument<AbonoCambio>;

/**
 * Historial de abonos de un cliente: un registro por cada vez que se cargó o
 * cambió el monto. Nunca se edita ni se borra.
 */
@Schema(baseSchemaOptions)
export class AbonoCambio {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Cliente', required: true })
  clienteId: Types.ObjectId;

  /** Sin valor en el primer registro (todavía no había abono). */
  @Prop()
  montoAnterior?: number;

  @Prop({ required: true, min: 0 })
  montoNuevo: number;

  @Prop({ required: true })
  fecha: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  usuarioId?: Types.ObjectId;

  @Prop({ trim: true })
  usuarioNombre?: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const AbonoCambioSchema = SchemaFactory.createForClass(AbonoCambio);
AbonoCambioSchema.index({ estudioId: 1, clienteId: 1, fecha: 1 });
