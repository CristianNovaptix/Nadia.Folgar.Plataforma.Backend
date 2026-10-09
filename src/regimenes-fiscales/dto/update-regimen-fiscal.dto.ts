import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength, ValidateNested } from 'class-validator';
import { Jurisdiccion } from '../../iva-tareas/schemas/tarea-presentacion.schema';
import { FrecuenciaObligacion } from '../schemas/regimen-fiscal-config.schema';

export class ObligacionRegimenDto {
  @IsString()
  @MinLength(2)
  nombre: string;

  @IsOptional()
  @IsEnum(Jurisdiccion)
  jurisdiccion?: Jurisdiccion;

  @IsOptional()
  @IsEnum(FrecuenciaObligacion)
  frecuencia?: FrecuenciaObligacion;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  mesInicio?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(12, { each: true })
  meses?: number[];

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
