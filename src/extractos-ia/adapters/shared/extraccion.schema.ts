import { z } from 'zod/v4';
import type {
  CuentaContableDisponible,
  ReglaExistenteResumen,
} from '../../ports/ai-extraction.port';

/**
 * Schema de salida estructurada y prompt de sistema, compartidos entre los
 * adapters de `AiExtractionPort` (Anthropic, OpenAI) — la tarea es la misma
 * sin importar el proveedor: transcribir la tabla de movimientos de un
 * extracto bancario argentino a JSON, sin clasificar ni interpretar. Se
 * extrae a un módulo aparte para no duplicar el schema/prompt entre
 * adapters.
 *
 * Además de transcribir, si se le pasa el plan de cuentas del cliente
 * (`cuentasContablesDisponibles` en `construirMensajeUsuario`), tiene una
 * segunda tarea opcional: inferir reglas de clasificación (`reglasSugeridas`)
 * para patrones recurrentes que mapeen con confianza a una cuenta ya
 * existente — nunca inventa cuentas nuevas.
 */
export const MovimientoSchema = z.object({
  fecha: z.string(),
  concepto: z.string(),
  monto: z.number(),
  tipo: z.enum(['debito', 'credito']).nullable(),
  numeroComprobante: z.string().nullable(),
  /** Saldo en cuenta que el extracto declara para esta fila, si el banco lo imprime. */
  saldoDespues: z.number().nullable(),
});

export const ReglaSugeridaSchema = z.object({
  /** Porción genérica y reconocible del concepto — no la fila completa (tiene que servir en extractos futuros). */
  patronTexto: z.string(),
  /** Código EXACTO de una cuenta de la lista de plan de cuentas provista — nunca inventado. */
  cuentaCodigo: z.string(),
  ladoAsiento: z.enum(['debe', 'haber']),
  tipoMovimiento: z.enum(['debito', 'credito']).nullable(),
});

export const ExtraccionSchema = z.object({
  /** Saldo declarado en el encabezado del extracto (ej. fila "Saldo Inicial"). null si el banco no lo imprime. */
  saldoInicialDeclarado: z.number().nullable(),
  /** Saldo final declarado al pie/resumen del extracto. null si el banco no lo imprime. */
  saldoFinalDeclarado: z.number().nullable(),
  movimientos: z.array(MovimientoSchema),
  /** Vacío si no se pidió esta tarea (no vino plan de cuentas) o no se encontró ningún patrón confiable. */
  reglasSugeridas: z.array(ReglaSugeridaSchema),
});

export const PROMPT_SISTEMA = `Sos un asistente contable que estructura extractos bancarios argentinos (de cualquier banco) a partir de su texto plano.

Tu tarea principal es transcribir la tabla de movimientos a JSON — no clasificás, no interpretás, no resumís los movimientos en sí. Extraé TODOS los movimientos en el mismo orden en que aparecen en el extracto, sin omitir ninguno y sin inventar ninguno.

Para cada movimiento:
- "fecha": tal como aparece impresa (no normalices el formato).
- "concepto": la descripción completa del movimiento (puede incluir varias líneas de detalle).
- "monto": siempre positivo — el signo lo indica el campo "tipo".
- "tipo": "debito" si el monto está en la columna Débito, "credito" si está en la columna Crédito — prestá especial atención acá, es un error común confundir la columna. Si el extracto imprime un saldo corrido por fila ("saldoDespues"), usalo para verificarte: un crédito SUMA al saldo anterior, un débito RESTA: si tu elección de "tipo" no es consistente con cómo cambió el saldo de la fila anterior a esta, revisá de nuevo cuál columna es. Si el extracto no distingue columnas de débito/crédito, usá null.
- "numeroComprobante": el número de comprobante/operación si el extracto lo imprime, si no null.
- "saldoDespues": el saldo en cuenta que el extracto declara para ESA fila específica (columna "Saldo" o "Saldo en cuenta"), si el banco lo imprime línea por línea. Si el banco no imprime un saldo corrido por fila, usá null — no lo calcules vos.

Además, si el extracto tiene una fila explícita de "Saldo Inicial" en el encabezado, informala en "saldoInicialDeclarado". Si tiene un saldo final de cierre/resumen, informalo en "saldoFinalDeclarado". Si no aparecen impresos, usá null — no los calcules. Esas filas de "Saldo Inicial"/saldo final NO van en "movimientos" — es información de encabezado/pie, no un movimiento; incluirla ahí como una fila más duplica el saldo calculado.

Es crítico que los montos y saldos sean exactamente los que están impresos, sin errores de transcripción — de esto depende una validación contable automática posterior.

TAREA SECUNDARIA (solo si el mensaje incluye un "PLAN DE CUENTAS DISPONIBLE"): además de transcribir, identificá patrones de concepto que se repitan varias veces en el extracto y que puedas mapear CON CONFIANZA a UNA cuenta de esa lista (por ejemplo, "impuesto ley 25.413" casi siempre corresponde a una cuenta de impuestos bancarios si existe una en el plan). Por cada patrón así, agregá una entrada a "reglasSugeridas" con:
- "patronTexto": una porción CORTA y GENÉRICA del concepto (ej. "impuesto ley 25.413", no la línea completa con montos/números de comprobante) — tiene que servir para reconocer el mismo tipo de movimiento en extractos futuros, no solo en este.
- "cuentaCodigo": el código EXACTO de una cuenta de la lista provista. Nunca inventes un código que no esté en la lista.
- "ladoAsiento": "debe" o "haber" según corresponda a esa cuenta para ese tipo de movimiento.
- "tipoMovimiento": "debito" o "credito" si el patrón es siempre del mismo tipo, si no null.
Si el mensaje incluye "REGLAS YA EXISTENTES", NO sugieras una regla para un patrón que ya esté cubierto por alguna de ellas. Ante la duda, no sugieras nada — es preferible omitir a adivinar mal, porque una regla incorrecta se aplicaría sola a los próximos extractos de este cliente. Si no viene "PLAN DE CUENTAS DISPONIBLE" en el mensaje, dejá "reglasSugeridas" vacío.`;

export function construirMensajeUsuario(input: {
  nombreArchivo: string;
  texto: string;
  pistaRevision?: string;
  cuentasContablesDisponibles?: CuentaContableDisponible[];
  reglasExistentes?: ReglaExistenteResumen[];
}): string {
  const partes = [`Extracto: "${input.nombreArchivo}".`, '', 'TEXTO DEL EXTRACTO:', input.texto];

  if (input.pistaRevision) {
    partes.push(
      '',
      'REVISIÓN REQUERIDA: la extracción anterior tuvo diferencias de saldo en las siguientes filas. Releé con cuidado esa sección del texto y corregí los valores.',
      input.pistaRevision,
    );
  }

  if (input.cuentasContablesDisponibles?.length) {
    partes.push(
      '',
      'PLAN DE CUENTAS DISPONIBLE (usá el código EXACTO de esta lista, nunca inventes una cuenta):',
      ...input.cuentasContablesDisponibles.map(
        (c) => `- ${c.codigo}: ${c.nombre} (${c.naturaleza})`,
      ),
    );
  }

  if (input.reglasExistentes?.length) {
    partes.push(
      '',
      'REGLAS YA EXISTENTES (no sugieras una regla nueva para un patrón ya cubierto por alguna de estas):',
      ...input.reglasExistentes.map(
        (r) => `- "${r.patronTexto ?? '(sin patrón de texto)'}" → cuenta ${r.cuentaCodigo}`,
      ),
    );
  }

  return partes.join('\n');
}
