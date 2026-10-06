import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { Jurisdiccion } from '../../iva-tareas/schemas/tarea-presentacion.schema';

export class ObligacionRegimenDto {
  @IsString()
  @MinLength(2)
  nombre: string;

  @IsOptional()
  @IsEnum(Jurisdiccion)
  jurisdiccion?: Jurisdiccion;
}

export class UpdateRegimenFiscalDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ObligacionRegimenDto)
  obligaciones: ObligacionRegimenDto[];
}
