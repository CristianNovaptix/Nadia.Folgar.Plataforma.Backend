import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsISO8601,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { EstadoTarea, Jurisdiccion, Prioridad } from '../schemas/tarea-presentacion.schema';
import { ChecklistItemDto } from './checklist-item.dto';
import { EtiquetaDto } from './etiqueta.dto';

/**
 * Alta manual de una tarea (fuera del ciclo automático de
 * `generarTareasDelMes`) — pensada para casos excepcionales, ej. un cliente
 * que se suma a mitad de mes. El flujo normal es el cron mensual.
 */
export class CreateTareaPresentacionDto {
  @IsMongoId()
  clienteId: string;

  /**
   * Opcional: ya no es un campo que el usuario elige a mano — el Frontend lo
   * deriva de si la tarjeta tiene aplicada una etiqueta ARCA/ARBA/AGIP (ver
   * `jurisdiccionDeEtiquetas` del Frontend). Sigue existiendo como campo
   * propio (no solo dentro de `etiquetas`) porque `findKanban`/el dashboard
   * filtran y agrupan por acá.
   */
  @IsOptional()
  @IsEnum(Jurisdiccion)
  jurisdiccion?: Jurisdiccion;

  /** Formato "YYYY-MM". */
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'periodo debe tener el formato YYYY-MM' })
  periodo: string;

  /**
   * Vencimiento de la tarjeta (rango opcional, equivalente a "Fechas" de
   * Trello) — reemplaza al viejo selector de "Período" como único campo de
   * fecha editable a mano. `periodo` (arriba) sigue siendo obligatorio como
   * campo derivado interno: el Frontend lo calcula de `fechaHasta` (o
   * `fechaDesde`) antes de mandar el alta.
   */
  @IsOptional()
  @IsISO8601()
  fechaDesde?: string;

  @IsOptional()
  @IsISO8601()
  fechaHasta?: string;

  @IsOptional()
  @IsEnum(EstadoTarea)
  estado?: EstadoTarea;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  asignados?: string[];

  /** Texto libre, tipo "descripción" de Trello. */
  @IsOptional()
  @IsString()
  @MaxLength(5000, { message: 'descripcion no puede superar los 5000 caracteres' })
  descripcion?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemDto)
  checklist?: ChecklistItemDto[];

  @IsOptional()
  @IsEnum(Prioridad)
  prioridad?: Prioridad;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EtiquetaDto)
  etiquetas?: EtiquetaDto[];

  /** Hex de 6 dígitos, ej. "#96602f" — equivalente simplificado a la "cover" de Trello. */
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'portadaColor debe ser un hex de 6 dígitos, ej. #96602f',
  })
  portadaColor?: string;

  /**
   * Título propio de la tarjeta — solo lo traen las tareas importadas desde
   * documento (`ImportarTareasDocumentoDto` las crea con esto poblado). Acá
   * se admite como opcional para que `UpdateTareaPresentacionDto` (que
   * extiende este DTO con `PartialType`) permita editarlo desde el lápiz de
   * la tarjeta en el Frontend — el alta manual normal no lo usa.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: 'titulo no puede superar los 300 caracteres' })
  titulo?: string;
}
