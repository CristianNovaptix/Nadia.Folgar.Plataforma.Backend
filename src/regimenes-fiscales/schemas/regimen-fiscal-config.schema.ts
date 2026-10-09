import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';
import { RegimenFiscal } from '../../clientes/schemas/cliente.schema';
import { Jurisdiccion } from '../../iva-tareas/schemas/tarea-presentacion.schema';

export type RegimenFiscalConfigDocument = HydratedDocument<RegimenFiscalConfig>;

/** Cada cuánto se presenta una obligación (y por lo tanto cada cuánto se crea su tarjeta). */
export enum FrecuenciaObligacion {
  MENSUAL = 'mensual',
  BIMESTRAL = 'bimestral',
  TRIMESTRAL = 'trimestral',
  CUATRIMESTRAL = 'cuatrimestral',
  SEMESTRAL = 'semestral',
  ANUAL = 'anual',
  /** Meses elegidos a mano que no coinciden con ninguna frecuencia fija (ver `meses`). */
  PERSONALIZADA = 'personalizada',
}

/** Cantidad de meses entre una creación y la siguiente (personalizada se rige solo por `meses`). */
export const MESES_POR_FRECUENCIA: Record<FrecuenciaObligacion, number> = {
  [FrecuenciaObligacion.MENSUAL]: 1,
  [FrecuenciaObligacion.BIMESTRAL]: 2,
  [FrecuenciaObligacion.TRIMESTRAL]: 3,
  [FrecuenciaObligacion.CUATRIMESTRAL]: 4,
  [FrecuenciaObligacion.SEMESTRAL]: 6,
  [FrecuenciaObligacion.ANUAL]: 12,
  [FrecuenciaObligacion.PERSONALIZADA]: 1,
};

/**
 * ¿Le toca crear tarjeta a una obligación en el mes `mes` (1-12)? Si tiene `meses` elegidos, solo
 * en esos. Si no (cargadas antes de existir `meses`): mensual siempre; el resto en `mesInicio`
 * (default enero) y cada N meses desde ahí (ej. trimestral desde enero → 1, 4, 7, 10).
 */
export function correspondeAlMes(
  obligacion: Pick<ObligacionRegimen, 'frecuencia' | 'mesInicio' | 'meses'>,
  mes: number,
): boolean {
  if (obligacion.meses?.length) return obligacion.meses.includes(mes);
  const cada = MESES_POR_FRECUENCIA[obligacion.frecuencia ?? FrecuenciaObligacion.MENSUAL];
  return (((mes - (obligacion.mesInicio ?? 1)) % cada) + cada) % cada === 0;
}

/** Una presentación que exige un régimen fiscal (ej. "Declaración jurada de IVA"), con su frecuencia. */
@Schema({ _id: false })
export class ObligacionRegimen {
  @Prop({ required: true, trim: true })
  nombre: string;

  /** Organismo ante el que se presenta — opcional, solo da color/etiqueta a la tarjeta. */
  @Prop({ type: String, enum: Jurisdiccion, required: false })
  jurisdiccion?: Jurisdiccion;

  /** Sin cargar = mensual. */
  @Prop({ type: String, enum: FrecuenciaObligacion, required: false })
  frecuencia?: FrecuenciaObligacion;

  /** Mes (1-12) en que arranca el ciclo cuando no es mensual (ej. anual en marzo). Sin cargar = enero. */
  @Prop({ type: Number, min: 1, max: 12, required: false })
  mesInicio?: number;

  /** Meses (1-12) en que se crea la tarjeta, elegidos a mano. Si está cargado, manda sobre frecuencia/mesInicio. */
  @Prop({ type: [Number], default: undefined, required: false })
  meses?: number[];

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
