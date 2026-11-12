import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type ComunicadoEstadoDocument = HydratedDocument<ComunicadoEstado>;

/**
 * Estado de un comunicado en la campanita del portal para UN usuario: leído, en
 * papelera o eliminado para siempre (solo de su campanita: el comunicado sigue
 * existiendo en "Comunicados"). Mismo criterio que `AlertaTareaEstado`.
 */
@Schema(baseSchemaOptions)
export class ComunicadoEstado {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Comunicado', required: true })
  comunicadoId: Types.ObjectId;

  @Prop({ default: false })
  leida: boolean;

  @Prop({ default: false })
  enPapelera: boolean;

  @Prop({ default: false })
  eliminada: boolean;
}

export const ComunicadoEstadoSchema = SchemaFactory.createForClass(ComunicadoEstado);
ComunicadoEstadoSchema.index({ userId: 1, comunicadoId: 1 }, { unique: true });
