import { IsIn, IsMongoId, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryDocumentoDto extends PaginationQueryDto {
  /**
   * Solo tiene efecto para usuarios admin/contador — si quien pide el
   * listado es un usuario con rol 'cliente', el service IGNORA este campo
   * y fuerza el filtro a su propio `clienteId` (ver
   * `PortalClientesService.findDocumentosParaUsuario`).
   */
  @IsOptional()
  @IsMongoId()
  clienteId?: string;

  /** 'true' lista solo los documentos en la papelera (nunca para el rol 'cliente'). */
  @IsOptional()
  @IsIn(['true', 'false'])
  papelera?: string;

  /** 'true' no manda el contenido (base64): el listado carga rápido y el contenido se pide aparte por id. */
  @IsOptional()
  @IsIn(['true', 'false'])
  sinContenido?: string;
}
