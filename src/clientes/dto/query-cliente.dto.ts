import { IsEnum, IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { RegimenFiscal } from '../schemas/cliente.schema';

export class QueryClienteDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(RegimenFiscal)
  regimenFiscal?: RegimenFiscal;

  /** `'true'` lista solo la papelera; ausente/`'false'` la excluye. String para no depender de la conversión implícita de booleanos. */
  @IsOptional()
  @IsIn(['true', 'false'])
  enPapelera?: 'true' | 'false';
}
