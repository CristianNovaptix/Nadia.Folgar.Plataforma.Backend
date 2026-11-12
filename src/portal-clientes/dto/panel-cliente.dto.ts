import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class LineaImporteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  concepto: string;

  @IsNumber()
  @Min(0)
  importe: number;
}

/** Guarda el mes completo: lo que no venga queda vacío. `null` en facturación/gastos = usar ARCA. */
export class GuardarPanelClienteDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  facturacion?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  gastos?: number | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineaImporteDto)
  empleados: LineaImporteDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineaImporteDto)
  cargasSociales: LineaImporteDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineaImporteDto)
  impuestos: LineaImporteDto[];
}
