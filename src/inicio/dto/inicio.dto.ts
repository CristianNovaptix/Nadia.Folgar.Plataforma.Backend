import {
  IsBoolean,
  IsDateString,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;
const PERIODO_MSG = 'periodo debe tener formato YYYY-MM';

export class QueryPeriodoDto {
  @Matches(PERIODO, { message: PERIODO_MSG })
  periodo: string;
}

export class CreateGastoDto {
  @Matches(PERIODO, { message: PERIODO_MSG })
  periodo: string;

  @IsString()
  @MinLength(1)
  concepto: string;

  @IsNumber()
  @Min(0)
  monto: number;
}

export class UpdateGastoDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  concepto?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  monto?: number;
}

/** `null` borra el importe manual de ese mes y vuelve a usarse el total calculado. */
export class UpsertImporteManualDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  facturado?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  cobrado?: number | null;
}

export class QueryReunionesDto {
  @IsDateString()
  desde: string;

  @IsDateString()
  hasta: string;
}

export class CreateReunionDto {
  @IsString()
  @MinLength(2)
  titulo: string;

  @IsDateString()
  fecha: string;

  @IsOptional()
  @IsMongoId()
  clienteId?: string;

  @IsOptional()
  @IsString()
  enlace?: string;
}

export class UpdateReunionDto {
  /** Mandar/sacar la reunión de la papelera del calendario. */
  @IsOptional()
  @IsBoolean()
  enPapelera?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(2)
  titulo?: string;

  @IsOptional()
  @IsDateString()
  fecha?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsMongoId()
  clienteId?: string | null;

  @IsOptional()
  @IsString()
  enlace?: string;
}
