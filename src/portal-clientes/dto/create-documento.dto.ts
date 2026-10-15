import {
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Tope de tamaño del archivo ORIGINAL (antes de codificar en base64) que se
 * acepta por documento — ver la nota de alcance en `documento.schema.ts`
 * sobre por qué esto vive en Mongo como base64 en vez de un storage real.
 * 5 MB es un límite razonable para comprobantes/PDFs de un estudio contable
 * sin crear documentos gigantes en la base.
 */
export const MAX_DOCUMENTO_BYTES = 5 * 1024 * 1024;

/**
 * Un string base64 ocupa ~4/3 del tamaño del binario original, más relleno.
 * Se deja margen extra para no rechazar por redondeo un archivo que sí
 * cumple `MAX_DOCUMENTO_BYTES`.
 */
const MAX_BASE64_LENGTH = Math.ceil(MAX_DOCUMENTO_BYTES / 3) * 4 + 1024;

export class CreateDocumentoDto {
  @IsMongoId()
  clienteId: string;

  /** Carpeta donde se guarda (`CarpetaDocumento`); sin valor = raíz del cliente. */
  @IsOptional()
  @IsMongoId()
  carpetaId?: string | null;

  @IsString()
  @IsNotEmpty()
  nombre: string;

  @IsString()
  @IsNotEmpty()
  contentType: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BASE64_LENGTH, {
    message: `El documento supera el tamaño máximo permitido (${Math.floor(
      MAX_DOCUMENTO_BYTES / (1024 * 1024),
    )} MB)`,
  })
  contenidoBase64: string;

  @IsInt()
  @Min(1)
  @Max(MAX_DOCUMENTO_BYTES, {
    message: `tamanioBytes no puede superar ${Math.floor(MAX_DOCUMENTO_BYTES / (1024 * 1024))} MB`,
  })
  tamanioBytes: number;
}
