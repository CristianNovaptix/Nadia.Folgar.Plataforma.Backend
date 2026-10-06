import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type ReunionDocument = HydratedDocument<Reunion>;

/** Reunión/meet cargada a mano (card "Reuniones / Meets" del Inicio) — con un cliente o con cualquier otra persona. */
@Schema(baseSchemaOptions)
export class Reunion {
  @Prop({ required: true, trim: true })
  titulo: string;

  @Prop({ required: true, index: true })
  fecha: Date;

  /** Opcional: una reunión puede no ser con un cliente de la cartera. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Cliente' })
  clienteId?: Types.ObjectId;

  /** Link de Meet/Zoom/etc. */
  @Prop({ trim: true })
  enlace?: string;

  /** Papelera del calendario: oculta la reunión hasta restaurarla o eliminarla definitivamente. */
  @Prop({ default: false, index: true })
  enPapelera: boolean;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const ReunionSchema = SchemaFactory.createForClass(Reunion);
