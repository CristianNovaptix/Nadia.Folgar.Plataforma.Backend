import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateTareaPresentacionDto } from './create-tarea-presentacion.dto';

/** Edición de checklist/asignación/estado de una tarea ya generada. */
export class UpdateTareaPresentacionDto extends PartialType(CreateTareaPresentacionDto) {
  /** Mandar/sacar la tarjeta de la papelera del tablero. */
  @IsOptional()
  @IsBoolean()
  enPapelera?: boolean;
}
