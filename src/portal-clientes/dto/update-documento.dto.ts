import { OmitType, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateDocumentoDto } from './create-documento.dto';

/** Renombrar un documento o reemplazar su contenido (ej. un documento creado desde la carpeta del cliente). */
export class UpdateDocumentoDto extends PartialType(
  OmitType(CreateDocumentoDto, ['clienteId', 'carpetaId'] as const),
) {
  /** Mandar a la papelera (true) o restaurar (false). */
  @IsOptional()
  @IsBoolean()
  enPapelera?: boolean;
}
