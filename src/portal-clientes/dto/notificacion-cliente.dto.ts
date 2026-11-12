import { IsBoolean, IsOptional } from 'class-validator';

export class ActualizarNotificacionClienteDto {
  @IsOptional()
  @IsBoolean()
  leida?: boolean;

  @IsOptional()
  @IsBoolean()
  enPapelera?: boolean;
}
