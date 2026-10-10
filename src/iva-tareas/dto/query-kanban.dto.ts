import { IsEnum, IsMongoId, IsOptional, IsString, Matches } from 'class-validator';
import { Jurisdiccion } from '../schemas/tarea-presentacion.schema';

/** Filtros del tablero Kanban — sin paginación: siempre trae la lista completa del período. */
export class QueryKanbanDto {
  @IsOptional()
  @IsEnum(Jurisdiccion)
  jurisdiccion?: Jurisdiccion;

  /** Filtra tareas donde este usuario está entre los asignados (ej. "Mis tareas" en el Frontend). */
  @IsOptional()
  @IsMongoId()
  miembro?: string;

  /** Formato "YYYY-MM". Si no se pasa, se usa el período actual. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'periodo debe tener el formato YYYY-MM' })
  periodo?: string;

  /** Rango "YYYY-MM" (inclusive). Si viene alguno de los dos, manda sobre `periodo`. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'periodoDesde debe tener el formato YYYY-MM' })
  periodoDesde?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'periodoHasta debe tener el formato YYYY-MM' })
  periodoHasta?: string;
}
