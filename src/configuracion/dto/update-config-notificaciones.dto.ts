import { IsInt, Max, Min } from 'class-validator';

export class UpdateConfigNotificacionesDto {
  /** Entre 1 hora y 30 días. */
  @IsInt()
  @Min(1)
  @Max(720)
  anticipacionAvisoTareasHoras: number;
}
