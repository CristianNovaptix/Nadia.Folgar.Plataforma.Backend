import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateDocumentoDto } from './create-documento.dto';

/** Renombrar un documento o reemplazar su contenido (ej. un documento creado desde la carpeta del cliente). */
export class UpdateDocumentoDto extends PartialType(OmitType(CreateDocumentoDto, ['clienteId'] as const)) {}
