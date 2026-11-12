import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type PanelClienteMesDocument = HydratedDocument<PanelClienteMes>;

/** Un renglón con importe: un empleado y su sueldo neto, un pago de cargas sociales o un impuesto. */
@Schema({ _id: false })
export class LineaImporte {
  @Prop({ required: true, trim: true })
  concepto: string;

  @Prop({ required: true, min: 0 })
  importe: number;
}
export const LineaImporteSchema = SchemaFactory.createForClass(LineaImporte);

/**
 * Lo que el estudio carga a mano, por mes, para el Inicio del portal de un cliente
 * (pestaña "Panel del cliente" de su carpeta). `facturacion`/`gastos` cargados
 * reemplazan a lo que informa ARCA para ese mes; sin cargar, se usa ARCA.
 */
@Schema(baseSchemaOptions)
export class PanelClienteMes {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Cliente', required: true, index: true })
  clienteId: Types.ObjectId;

  /** AAAA-MM */
  @Prop({ required: true })
  periodo: string;

  @Prop({ min: 0 })
  facturacion?: number;

  @Prop({ min: 0 })
  gastos?: number;

  /** Empleados con su sueldo neto. */
  @Prop({ type: [LineaImporteSchema], default: [] })
  empleados: LineaImporte[];

  /** F.931 y sindicatos. */
  @Prop({ type: [LineaImporteSchema], default: [] })
  cargasSociales: LineaImporte[];

  /** Impuestos pagados. */
  @Prop({ type: [LineaImporteSchema], default: [] })
  impuestos: LineaImporte[];

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const PanelClienteMesSchema = SchemaFactory.createForClass(PanelClienteMes);
PanelClienteMesSchema.index({ estudioId: 1, clienteId: 1, periodo: 1 }, { unique: true });
