import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type ClienteEventoDocument = HydratedDocument<ClienteEvento>;

/**
 * Historial de un cliente ("Ver historial" del menú de Clientes) — pedido
 * explícito del usuario: todo lo que pasa con un cliente queda guardado acá
 * para siempre, aunque después se borre el registro de origen (un extracto,
 * una reunión, etc.).
 *
 * Dos formas de llegar acá (ver `ClienteHistorialService`):
 * - Acciones sobre el cliente mismo (activar, desactivar, editar, papelera,
 *   cambiar contraseña del portal): se graban en el momento, sin `origenId`.
 * - Registros de otros módulos (extractos, reuniones, documentos, facturas,
 *   tareas, vencimientos, avisos): se copian con `origenId` al consultar el
 *   historial. El índice único evita duplicarlos.
 */
@Schema(baseSchemaOptions)
export class ClienteEvento {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Cliente', required: true, index: true })
  clienteId: Types.ObjectId;

  @Prop({ required: true })
  tipo: string;

  @Prop({ required: true, trim: true })
  descripcion: string;

  @Prop({ required: true, index: true })
  fecha: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  usuarioId?: Types.ObjectId;

  @Prop({ trim: true })
  usuarioNombre?: string;

  /** Id del registro de otro módulo que originó el evento (extracto, reunión, etc.). */
  @Prop({ type: SchemaTypes.ObjectId })
  origenId?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const ClienteEventoSchema = SchemaFactory.createForClass(ClienteEvento);

ClienteEventoSchema.index(
  { clienteId: 1, tipo: 1, origenId: 1 },
  { unique: true, partialFilterExpression: { origenId: { $exists: true } } },
);
