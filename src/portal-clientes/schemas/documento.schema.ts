import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type DocumentoDocument = HydratedDocument<Documento>;

/**
 * ⚠️ DECISIÓN TEMPORAL DE ALCANCE (FOLGAR-024) ⚠️
 * Todavía no hay una solución de storage de objetos confirmada para el
 * proyecto (S3/Blob Storage — eso es tarea del módulo "Despliegue e
 * Infraestructura", FOLGAR-073 a 077). Mientras tanto, el contenido del
 * documento se guarda como base64 DIRECTO en este documento de Mongo.
 * Esto es aceptable para el volumen de un piloto, pero NO escala: infla el
 * tamaño de la colección y el de cada respuesta HTTP que lo incluya. Por eso
 * el DTO de alta (`CreateDocumentoDto`) le pone un tope de tamaño al archivo
 * (ver `MAX_DOCUMENTO_BYTES` en ese archivo).
 * Reemplazar por un adapter de storage real (el documento pasaría a guardar
 * solo una key/URL, no el contenido) apenas se confirme el proveedor — mismo
 * patrón puerto/adapter que `MessagingProvider`, sin tocar el resto del
 * dominio de este módulo.
 */
@Schema(baseSchemaOptions)
export class Documento {
  @Prop({ required: true, trim: true })
  nombre: string;

  @Prop({ required: true })
  contentType: string;

  /** Contenido del archivo codificado en base64 — ver nota de alcance arriba. */
  @Prop({ required: true })
  contenidoBase64: string;

  @Prop({ required: true, min: 0 })
  tamanioBytes: number;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Cliente', required: true, index: true })
  clienteId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;

  /** Papelera de "Documentación" del cliente: no se borra hasta eliminarlo definitivamente. */
  @Prop({ default: false, index: true })
  enPapelera: boolean;

  /** Carpeta de la documentación del cliente (`CarpetaDocumento`); null = raíz. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'CarpetaDocumento', default: null, index: true })
  carpetaId: Types.ObjectId | null;
}

export const DocumentoSchema = SchemaFactory.createForClass(Documento);
DocumentoSchema.index({ estudioId: 1, clienteId: 1 });
