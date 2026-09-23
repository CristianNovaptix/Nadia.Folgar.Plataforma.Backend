import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateAlertaTareaDto {
  @IsOptional()
  @IsBoolean()
  leida?: boolean;

  /** `false` = restaurar desde la papelera. */
  @IsOptional()
  @IsBoolean()
  enPapelera?: boolean;
}
