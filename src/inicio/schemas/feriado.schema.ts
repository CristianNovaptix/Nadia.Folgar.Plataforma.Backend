import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type FeriadoDocument = HydratedDocument<Feriado>;

/**
 * Feriado cargado a mano por un contador, además de los nacionales que el
 * calendario del Inicio ya calcula solo en el Frontend.
 */
@Schema(baseSchemaOptions)
export class Feriado {
  /** "YYYY-MM-DD", día local sin hora. */
  @Prop({ required: true, index: true })
  fecha: string;

  @Prop({ required: true, trim: true })
  nombre: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const FeriadoSchema = SchemaFactory.createForClass(Feriado);
