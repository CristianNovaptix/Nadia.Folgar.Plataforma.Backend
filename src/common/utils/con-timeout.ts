/**
 * Corre `promise` contra un límite de tiempo propio: si no resolvió/rechazó
 * en `ms`, la carrera la gana el timeout y `promise` queda "abandonada" — su
 * eventual resolución tardía no tiene ningún efecto si nada vuelve a leerla
 * (ver el uso en `ExtractosIaProcessor`/`ExtractosIaService`). Es la
 * herramienta genérica para la garantía dura de que ninguna llamada externa
 * (Redis, un proveedor de IA, lo que sea) deje una request o un job colgado
 * para siempre.
 */
export async function conTimeout<T>(
  promise: Promise<T>,
  ms: number,
  mensajeTimeout: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(mensajeTimeout)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
