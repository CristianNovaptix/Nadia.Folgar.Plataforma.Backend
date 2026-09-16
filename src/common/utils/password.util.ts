import { randomBytes } from 'crypto';

/**
 * Contraseña al azar criptográficamente segura — usada por cualquier flujo
 * que genere el único medio de acceso real de una cuenta (institucional,
 * credenciales de acceso de "Personal", usuario de portal de un "Cliente").
 * Se devuelve en texto plano una única vez en la respuesta del endpoint que
 * la generó — nunca se persiste así, solo su hash (`argon2`).
 */
export function generarPasswordSegura(): string {
  return randomBytes(12).toString('base64url');
}
