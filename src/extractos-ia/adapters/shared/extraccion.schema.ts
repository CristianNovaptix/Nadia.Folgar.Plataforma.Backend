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

En "concepto" copiá el texto del extracto tal cual (mismas palabras y abreviaturas, sin resumir, traducir ni reformular). Lo único que podés corregir son letras perdidas OBVIAS por la extracción de texto del PDF (ej. "frst data" → "first data", "Imp.afp" → "Imp.afip", "fnanciera" → "financiera"): el mismo movimiento tiene que quedar escrito igual todos los meses, porque las reglas de clasificación lo reconocen por su texto.

TAREA SECUNDARIA (solo si el mensaje incluye un "PLAN DE CUENTAS DISPONIBLE"): además de transcribir, revisá CADA movimiento que no esté cubierto por las "REGLAS YA EXISTENTES" (aparezca una vez o muchas — un débito automático de un servicio aparece una sola vez por mes, pero se repite todos los meses) y, si podés mapearlo CON CONFIANZA a UNA cuenta de esa lista, agregá una regla a "reglasSugeridas" con:
- "patronTexto": la porción del concepto que identifica a ESE tipo de movimiento, sin montos, fechas ni números de comprobante/operación que cambian cada mes — tiene que servir para extractos futuros, no solo para este. Si el concepto empieza con un tipo de operación genérico que por sí solo NO define la cuenta ("Debito automatico", "Debito directo", "Pago de servicios", "Transferencia realizada", "Transferencia recibida", "Pago comercios", etc.), el patrón TIENE que incluir también a quién se le paga o de quién se recibe (ej. "Pago de servicios Movistar", "Debito automatico Afip"), salvo que todos los movimientos con ese prefijo vayan sin duda a la misma cuenta. Nunca un patrón tan corto que pueda atrapar movimientos que van a otra cuenta.
- "cuentaCodigo": el código EXACTO de una cuenta de la lista provista. Nunca inventes un código que no esté en la lista.
- "ladoAsiento": es la contrapartida del banco — "debe" para débitos (sale dinero del banco), "haber" para créditos (entra dinero al banco).
- "tipoMovimiento": "debito" o "credito" según el tipo de los movimientos que cubre. Solo null si el mismo texto aparece de los dos lados y va a la misma cuenta.
NO sugieras regla cuando el mismo texto puede corresponder a cuentas distintas según el mes o el monto (ej. pagos de impuestos por VEP "Pago de servicios Imp.afip" con el mismo código, que pueden ser IVA, SUSS, Ganancias o IIBB y el extracto no dice cuál): esos los decide el contador. Tampoco sugieras regla si la única cuenta posible sería una genérica que no describe realmente al movimiento. Si el mensaje incluye "REGLAS YA EXISTENTES", NO sugieras una regla para un patrón (y tipo de movimiento) ya cubierto por alguna de ellas. Ante la duda, no sugieras nada — es preferible omitir a adivinar mal, porque una regla incorrecta se aplicaría sola a los próximos extractos de este cliente. Si no viene "PLAN DE CUENTAS DISPONIBLE" en el mensaje, dejá "reglasSugeridas" vacío.`;

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
      'REGLAS YA EXISTENTES (no sugieras una regla nueva para un patrón ya cubierto por alguna de estas — una regla "solo débitos" NO cubre los créditos con el mismo texto, ni al revés):',
      ...input.reglasExistentes.map(
        (r) =>
          `- "${r.patronTexto ?? '(sin patrón de texto)'}" (${
            r.tipoMovimiento === 'debito'
              ? 'solo débitos'
              : r.tipoMovimiento === 'credito'
                ? 'solo créditos'
                : 'débitos y créditos'
          }) → cuenta ${r.cuentaCodigo}`,
      ),
    );
  }

  return partes.join('\n');
}
