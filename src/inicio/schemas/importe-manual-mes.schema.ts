import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type ImporteManualMesDocument = HydratedDocument<ImporteManualMes>;

/**
 * Importe de facturación/cobranza cargado a mano para un mes en el que la
 * plataforma no tiene facturas propias (ej. los meses previos a empezar a
 * usarla). Si existe, reemplaza al total calculado de ese mes en los gráficos
 * "Evolución facturación"/"Evolución cobrado" del Inicio.
 */
@Schema(baseSchemaOptions)
export class ImporteManualMes {
  /** "YYYY-MM". */
  @Prop({ required: true })
  periodo: string;

  @Prop({ type: Number, min: 0, default: null })
  facturado?: number | null;

  @Prop({ type: Number, min: 0, default: null })
  cobrado?: number | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const ImporteManualMesSchema = SchemaFactory.createForClass(ImporteManualMes);
ImporteManualMesSchema.index({ estudioId: 1, periodo: 1 }, { unique: true });
