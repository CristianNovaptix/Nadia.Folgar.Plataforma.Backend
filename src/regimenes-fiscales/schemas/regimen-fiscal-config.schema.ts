import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';
import { RegimenFiscal } from '../../clientes/schemas/cliente.schema';
import { Jurisdiccion } from '../../iva-tareas/schemas/tarea-presentacion.schema';

export type RegimenFiscalConfigDocument = HydratedDocument<RegimenFiscalConfig>;

/** Una presentación que exige un régimen fiscal todos los meses (ej. "Declaración jurada de IVA"). */
@Schema({ _id: false })
export class ObligacionRegimen {
  @Prop({ required: true, trim: true })
  nombre: string;

  /** Organismo ante el que se presenta — opcional, solo da color/etiqueta a la tarjeta. */
  @Prop({ type: String, enum: Jurisdiccion, required: false })
  jurisdiccion?: Jurisdiccion;

  /** Día del mes en que se crea sola la tarjeta (y su fecha de inicio). Sin cargar = día 1. */
  @Prop({ type: Number, min: 1, max: 31, required: false })
  diaInicio?: number;

  /**
   * Día del mes en que vence (fecha límite de la tarjeta). Si es menor que `diaInicio`, vence
   * ese día del mes siguiente. Sin cargar = la tarjeta queda sin vencimiento.
   */
  @Prop({ type: Number, min: 1, max: 31, required: false })
  diaVencimiento?: number;
}

export const ObligacionRegimenSchema = SchemaFactory.createForClass(ObligacionRegimen);

/**
 * Qué presentaciones mensuales requiere cada régimen fiscal, cargado a mano por el estudio
 * (Configuración → "Régimen fiscal"). `IvaTareasService.generarTareasDelMes` crea una tarjeta por
 * cliente activo × obligación de su régimen — un cliente sin régimen cargado no genera nada.
 */
@Schema(baseSchemaOptions)
export class RegimenFiscalConfig {
  @Prop({ type: String, enum: RegimenFiscal, required: true })
  regimen: RegimenFiscal;

  @Prop({ type: [ObligacionRegimenSchema], default: [] })
  obligaciones: ObligacionRegimen[];

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const RegimenFiscalConfigSchema = SchemaFactory.createForClass(RegimenFiscalConfig);
RegimenFiscalConfigSchema.index({ estudioId: 1, regimen: 1 }, { unique: true });
