import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class QueryAlertasVencimientoDto {
  /** Anticipación del aviso "por vencer", en horas. Default 48. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  horas?: number;
}
