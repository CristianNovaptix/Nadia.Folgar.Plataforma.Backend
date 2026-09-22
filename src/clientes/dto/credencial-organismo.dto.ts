import { IsOptional, IsString } from 'class-validator';

/**
 * Usuario/contraseña de acceso a un organismo fiscal (ARCA/ARBA/AGIP) para
 * un cliente. `password` ausente/vacío = no tocar la contraseña ya
 * guardada (solo actualiza `usuario`, si vino) — ver
 * `ClientesService.aplicarCredencial`. Nunca se devuelve en las respuestas,
 * solo un preview (mismo criterio que las API keys de Configuración →
 * Integraciones).
 */
export class CredencialOrganismoDto {
  @IsOptional()
  @IsString()
  usuario?: string;

  @IsOptional()
  @IsString()
  password?: string;
}
