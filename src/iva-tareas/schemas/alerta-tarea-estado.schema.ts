import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type AlertaTareaEstadoDocument = HydratedDocument<AlertaTareaEstado>;

/**
 * Estado de una notificación de la campanita del Inicio ("tarea vencida/por
 * vencer") para UN usuario: leída, en papelera o eliminada para siempre. La
 * notificación en sí no se persiste — se calcula de la tarea. `fechaHasta`
 * guarda el vencimiento que tenía la tarea cuando se tocó el estado: si la
 * tarea cambia de vencimiento, es una notificación nueva y el estado viejo se ignora.
 */
@Schema(baseSchemaOptions)
export class AlertaTareaEstado {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TareaPresentacion', required: true })
  tareaId: Types.ObjectId;

  @Prop({ type: Date, required: true })
  fechaHasta: Date;

  @Prop({ default: false })
  leida: boolean;

  @Prop({ default: false })
  enPapelera: boolean;

  @Prop({ default: false })
  eliminada: boolean;
}

export const AlertaTareaEstadoSchema = SchemaFactory.createForClass(AlertaTareaEstado);
AlertaTareaEstadoSchema.index({ userId: 1, tareaId: 1 }, { unique: true });
