import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type GastoMensualDocument = HydratedDocument<GastoMensual>;

/**
 * Gasto del estudio cargado a mano para un mes (card "Gastos del mes" del
 * Inicio). Los gastos se repiten mes a mes, por eso existe
 * `InicioService.copiarGastosMesAnterior` en vez de recargarlos cada vez.
 */
@Schema(baseSchemaOptions)
export class GastoMensual {
  /** "YYYY-MM". */
  @Prop({ required: true, index: true })
  periodo: string;

  @Prop({ required: true, trim: true })
  concepto: string;

  @Prop({ required: true, min: 0 })
  monto: number;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const GastoMensualSchema = SchemaFactory.createForClass(GastoMensual);
GastoMensualSchema.index({ estudioId: 1, periodo: 1 });
