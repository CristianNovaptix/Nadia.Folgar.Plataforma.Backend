import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type CarpetaDocumentoDocument = HydratedDocument<CarpetaDocumento>;

/**
 * Carpeta de la "Documentación" de un cliente (estilo Drive). Puede estar
 * dentro de otra carpeta (`carpetaPadreId`); sin padre = raíz del cliente.
 * Los documentos apuntan a su carpeta con `Documento.carpetaId`.
 */
@Schema(baseSchemaOptions)
export class CarpetaDocumento {
  @Prop({ required: true, trim: true })
  nombre: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'CarpetaDocumento', default: null, index: true })
  carpetaPadreId: Types.ObjectId | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Cliente', required: true, index: true })
  clienteId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const CarpetaDocumentoSchema = SchemaFactory.createForClass(CarpetaDocumento);
CarpetaDocumentoSchema.index({ estudioId: 1, clienteId: 1 });
