import { normalizarTexto } from '../asientos-contables/asiento-contable.logic';
import { ExtraccionResultado, ReglaClasificacionSugerida } from './ports/ai-extraction.port';

/**
 * Bug real reportado: en extractos largos (ej. Santander de 35 páginas, ~700
 * movimientos) la IA tenía que devolver TODOS los movimientos en una sola
 * respuesta y esa respuesta tiene un tope de largo (`max_completion_tokens`
 * de OpenAI / `max_tokens` de Anthropic) — al llegar al tope se cortaba: con
 * OpenAI fallaba el extracto entero ("length limit was reached") y con
 * Anthropic se perdían los movimientos de las últimas páginas.
 *
 * Solución: si el texto supera `MAX_CARACTERES_UN_SOLO_TRAMO`, se parte por
 * páginas en tramos de hasta `MAX_CARACTERES_POR_TRAMO` y cada tramo va en su
 * propia llamada (respuesta chica, muy por debajo del tope). Los extractos
 * que ya entraban siguen yendo en una sola llamada, exactamente igual que
 * antes — mirar el documento entero ayuda a la IA a no confundir anexos
 * (ej. "detalle de transferencias recibidas") con movimientos. Si aun así una
 * llamada única se corta por largo, se reintenta por partes (`esCortePorLargo`).
 *
 * Medido con extractos reales: ~0,46 tokens de respuesta por carácter de
 * texto (Santander de 91.000 caracteres ≈ 42.000 tokens, por encima del tope
 * de 32.000 de OpenAI) — 45.000 caracteres deja margen.
 */
export const MAX_CARACTERES_UN_SOLO_TRAMO = 45000;
export const MAX_CARACTERES_POR_TRAMO = 12000;
/** Llamadas a la IA en paralelo como máximo. */
export const TRAMOS_EN_PARALELO = 4;
/** Primeras líneas de la página siguiente que se le muestran a un tramo para completar un movimiento cortado entre páginas. */
const LINEAS_CONTINUACION = 8;

export interface TramoTexto {
  texto: string;
  /** Comienzo del tramo siguiente, solo de contexto (no se transcribe). */
  continuacion?: string;
}

/** `forzar`: partir aunque no supere `MAX_CARACTERES_UN_SOLO_TRAMO` (reintento tras un corte por largo). */
export function armarTramos(texto: string, paginas?: string[], forzar = false): TramoTexto[] {
  if (
    !paginas ||
    paginas.length <= 1 ||
    texto.length <= (forzar ? MAX_CARACTERES_POR_TRAMO : MAX_CARACTERES_UN_SOLO_TRAMO)
  ) {
    return [{ texto }];
  }

  const grupos: string[][] = [];
  let actual: string[] = [];
  let largo = 0;
  for (const pagina of paginas) {
    if (actual.length > 0 && largo + pagina.length > MAX_CARACTERES_POR_TRAMO) {
      grupos.push(actual);
      actual = [];
      largo = 0;
    }
    actual.push(pagina);
    largo += pagina.length;
  }
  if (actual.length > 0) grupos.push(actual);

  return grupos.map((grupo, i) => ({
    texto: grupo.join('\n\n'),
    continuacion: grupos[i + 1]
      ? grupos[i + 1][0].split('\n').slice(0, LINEAS_CONTINUACION).join('\n')
      : undefined,
  }));
}

/** La respuesta de la IA se cortó por el tope de largo (mensajes de los adapters de OpenAI/Anthropic). */
export function esCortePorLargo(resultado: ExtraccionResultado): boolean {
  return (
    !resultado.exitoso &&
    /length limit|finish_reason: length|stop_reason: max_tokens/i.test(resultado.mensaje ?? '')
  );
}

/**
 * Saldo inicial: el del primer tramo que lo informe, sin pasar del primer tramo con movimientos
 * (un saldo "anterior" repetido más adelante no es el inicial). Saldo final: el último que se
 * informe (las páginas de legales o anexos posteriores al cierre no lo traen).
 */
export function combinarSaldos(resultados: ExtraccionResultado[]): {
  saldoInicialDeclarado?: number;
  saldoFinalDeclarado?: number;
} {
  let saldoInicialDeclarado: number | undefined;
  for (const r of resultados) {
    if (r.saldoInicialDeclarado !== undefined) {
      saldoInicialDeclarado = r.saldoInicialDeclarado;
      break;
    }
    if (r.movimientos.length > 0) break;
  }
  const saldoFinalDeclarado = [...resultados]
    .reverse()
    .find((r) => r.saldoFinalDeclarado !== undefined)?.saldoFinalDeclarado;
  return { saldoInicialDeclarado, saldoFinalDeclarado };
}

/**
 * Une las reglas sugeridas por cada tramo sin repetir el mismo patrón+tipo. Si dos tramos
 * sugieren cuentas distintas para el mismo patrón, se descarta (ante la duda, no sugerir).
 */
export function unificarReglasSugeridas(
  listas: ReglaClasificacionSugerida[][],
): ReglaClasificacionSugerida[] {
  const porClave = new Map<string, ReglaClasificacionSugerida | null>();
  for (const regla of listas.flat()) {
    const clave = `${normalizarTexto(regla.patronTexto ?? '')}|${regla.tipoMovimiento ?? ''}`;
    const previa = porClave.get(clave);
    if (previa === undefined) porClave.set(clave, regla);
    else if (previa && previa.cuentaCodigo !== regla.cuentaCodigo) porClave.set(clave, null);
  }
  return [...porClave.values()].filter((r): r is ReglaClasificacionSugerida => r !== null);
}

/** Como `Promise.all(items.map(fn))`, pero con a lo sumo `limite` en curso a la vez. Conserva el orden. */
export async function mapConConcurrencia<T, R>(
  items: T[],
  limite: number,
  fn: (item: T, indice: number) => Promise<R>,
): Promise<R[]> {
  const resultados = new Array<R>(items.length);
  let siguiente = 0;
  const trabajador = async (): Promise<void> => {
    while (siguiente < items.length) {
      const indice = siguiente++;
      resultados[indice] = await fn(items[indice], indice);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, trabajador));
  return resultados;
}
