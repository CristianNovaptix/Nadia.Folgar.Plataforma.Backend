import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';
import type { ArcaContribuyente, ArcaDatos } from '../ports/arca-portal.port';

export type ArcaSincronizacionDocument = HydratedDocument<ArcaSincronizacion>;

export enum ArcaSincronizacionEstado {
  SINCRONIZANDO = 'sincronizando',
  OK = 'ok',
  ERROR = 'error',
}

/**
 * Último resultado de sincronizar un cliente con ARCA usando su clave fiscal
 * (`Cliente.credencialesArca`). Un único registro por cliente, que se pisa en
 * cada sincronización, con los bloques de la pestaña ARCA del cliente y de
 * cada persona que representa (`datosPorCuit`).
 */
@Schema(baseSchemaOptions)
export class ArcaSincronizacion {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Cliente', required: true })
  clienteId: Types.ObjectId;

  @Prop({ type: String, enum: ArcaSincronizacionEstado, required: true })
  estado: ArcaSincronizacionEstado;

  /** Fecha de la última sincronización que terminó bien. */
  @Prop()
  ultimaSincronizacion?: Date;

  /** Fecha del último intento, haya terminado bien o mal. */
  @Prop()
  ultimoIntento?: Date;

  @Prop()
  ultimoError?: string;

  /** El propio cliente primero y después las personas que representa en ARCA. */
  @Prop({ type: SchemaTypes.Mixed })
  contribuyentes?: ArcaContribuyente[];

  /** Los bloques de la pestaña ARCA de cada contribuyente, por CUIT. */
  @Prop({ type: SchemaTypes.Mixed })
  datosPorCuit?: Record<string, ArcaDatos>;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const ArcaSincronizacionSchema = SchemaFactory.createForClass(ArcaSincronizacion);
ArcaSincronizacionSchema.index({ estudioId: 1, clienteId: 1 }, { unique: true });
