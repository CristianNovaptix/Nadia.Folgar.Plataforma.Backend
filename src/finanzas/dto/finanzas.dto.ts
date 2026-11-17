import {
  IsDateString,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { MedioPago } from '../schemas/deuda-honorario.schema';

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;
const PERIODO_MSG = 'periodo debe tener formato YYYY-MM';

export class GuardarHonorarioDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  abono: number;

  /** `null` = sin nadie asignado. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsMongoId()
  facturadorId?: string | null;

  /** `null` = sin día definido. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(31)
  diaEmision?: number | null;

  /** Desde qué día paga. `null` = el de por defecto (día 1). */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(31)
  diaInicioPago?: number | null;

  /** Hasta qué día puede pagar. `null` = el de por defecto (día 10). */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(31)
  diaVencimiento?: number | null;
}

/** Cambios sobre la deuda de un mes puntual: quién la factura y hasta cuándo se puede pagar. */
export class ActualizarDeudaDto {
  /** `null` = sin nadie asignado. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsMongoId()
  facturadorId?: string | null;

  /** "AAAA-MM-DD"; `null` = sin vencimiento. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fechaVencimiento debe tener formato AAAA-MM-DD' })
  fechaVencimiento?: string | null;
}

export class GenerarDeudasDto {
  @Matches(PERIODO, { message: PERIODO_MSG })
  periodo: string;

  /** Sin cliente = todos los clientes activos con abono que todavía no la tengan. */
  @IsOptional()
  @IsMongoId()
  clienteId?: string;
}

export class RegistrarPagoDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  monto: number;

  @IsOptional()
  @IsDateString()
  fecha?: string;

  @IsOptional()
  @IsEnum(MedioPago)
  medio?: MedioPago;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  nota?: string;

  /**
   * Mes al que corresponde el pago (solo en el pago del cliente). Si paga de más,
   * lo que sobra pasa a los meses que le siguen. Un mes futuro = pago por adelantado.
   */
  @IsOptional()
  @Matches(PERIODO, { message: PERIODO_MSG })
  periodo?: string;
}

export class AnularPagoDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  motivo: string;
}
