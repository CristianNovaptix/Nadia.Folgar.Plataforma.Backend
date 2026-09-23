import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';
import { ProveedorIA } from '../../common/enums/proveedor-ia.enum';

export type EstudioDocument = HydratedDocument<Estudio>;

/**
 * Un "Estudio" es el tenant del sistema (hoy solo existe Folgar). Todo dato
 * propio de un estudio contable (clientes, vencimientos, notificaciones...)
 * referencia un estudioId para no reescribir el modelo si se suma otro estudio.
 */
@Schema(baseSchemaOptions)
export class Estudio {
  @Prop({ required: true })
  nombre: string;

  @Prop({ required: true, unique: true })
  cuit: string;

  @Prop({ default: true })
  activo: boolean;

  /** Paleta/branding del estudio — placeholder hasta el Manual de Marca (FOLGAR-013 a 017). */
  @Prop({ type: Object, default: {} })
  branding: Record<string, unknown>;

  /**
   * Motor de IA que usan por defecto los procesos con IA del estudio
   * (Asistente IA institucional, y extractos-ia para los clientes que no
   * eligieron un `motorIaPreferido` propio) cuando hay una integración
   * conectada para ese proveedor (`IntegracionIa`). Si es `undefined`, o si
   * no hay ninguna integración conectada, se cae al `AI_PROVIDER` de entorno
   * — ver `AiProviderResolverService`.
   */
  @Prop({ type: String, enum: ProveedorIA })
  motorIaPorDefecto?: ProveedorIA;

  /**
   * Con cuántas horas de anticipación la campanita del Inicio avisa que una
   * tarjeta del tablero de Tareas está por vencer (`fechaHasta`). Editable en
   * Configuración → Notificaciones.
   */
  @Prop({ default: 48 })
  anticipacionAvisoTareasHoras: number;
}

export const EstudioSchema = SchemaFactory.createForClass(Estudio);
