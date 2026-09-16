/** Mismo dominio que ya usa la cuenta de admin de pruebas ("Yami", admin@folgar.com.ar). */
export const DOMINIO_INSTITUCIONAL = 'folgar.com.ar';

export function esEmailInstitucional(email: string): boolean {
  return email.toLowerCase().trim().endsWith(`@${DOMINIO_INSTITUCIONAL}`);
}

/**
 * "Nadia Folgar" -> "nadia.folgar" — sin tildes ni caracteres que no sean
 * letra/número, para armar un email institucional a partir de un nombre
 * completo (integrante de "Personal" o razón social de un "Cliente"). Ver
 * `UsersService.generarCredencialesInstitucionales` y
 * `ClientesService.crearUsuarioPortal`.
 */
export function slugDesdeNombre(nombre: string): string {
  // Descompone tildes/diéresis en letra base + marca combinante (NFD) y
  // descarta esa marca por rango de code point — evita escribir el rango
  // Unicode de marcas diacríticas como literal de regex en el código fuente.
  const sinTildes = Array.from(nombre.normalize('NFD'))
    .filter((caracter) => {
      const codePoint = caracter.codePointAt(0) ?? 0;
      return codePoint < 0x0300 || codePoint > 0x036f;
    })
    .join('');
  const partes = sinTildes
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return partes.join('.') || 'usuario';
}
