import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength, ValidateNested } from 'class-validator';
import { Jurisdiccion } from '../../iva-tareas/schemas/tarea-presentacion.schema';

export class ObligacionRegimenDto {
  @IsString()
  @MinLength(2)
  nombre: string;

  @IsOptional()
  @IsEnum(Jurisdiccion)
  jurisdiccion?: Jurisdiccion;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  diaInicio?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  diaVencimiento?: number;
}

export class UpdateRegimenFiscalDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ObligacionRegimenDto)
  obligaciones: ObligacionRegimenDto[];
}
