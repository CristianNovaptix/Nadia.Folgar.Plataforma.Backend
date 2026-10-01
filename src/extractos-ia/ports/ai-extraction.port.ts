/**
 * Puerto de extracción de movimientos bancarios vía IA (patrón puerto/adapter
 * — ver ADR #5 en CLAUDE.md: "Puerto/adapter para toda integración externa",
 * mismo estilo que `CatedralSyncPort` en `src/catedral/ports/catedral-sync.port.ts`).
 *
 * El adapter recibe el TEXTO ya extraído del PDF (por `PdfTextExtractorService`,
 * determinístico, sin IA) en vez del PDF binario — más barato en tokens y sin
 * los límites de tamaño de documento del proveedor. La única responsabilidad
 * de la IA acá es estructurar ese texto en movimientos; el parseo del PDF y
 * la validación de saldo (fila por fila, contra `saldoDespues`) son 100%
 * determinísticos y viven en `ExtractosIaService`, nunca delegados a la IA.
 *
 * `ExtractosIaService` depende únicamente de esta interfaz, inyectada vía el
 * token `AI_EXTRACTION_PORT` (nunca de una clase concreta) — el proveedor de
 * IA se selecciona por la variable de entorno `AI_PROVIDER` (`stub` en
 * desarrollo/tests, `anthropic` cuando hay `ANTHROPIC_API_KEY` configurada),
 * ver `extractos-ia.module.ts`.
 */

/** Tipo de movimiento bancario. Opcional: no todos los extractos/bancos lo distinguen con claridad. */
export type TipoMovimientoExtraido = 'debito' | 'credito';

export interface MovimientoExtraido {
  /** Fecha del movimiento tal como aparece en el extracto (texto libre — ver decisión en el schema). */
  fecha: string;
  /** Descripción/concepto del movimiento, usada además para agrupar subtotales. */
  concepto: string;
  /** Monto del movimiento. Convención: positivo = crédito, negativo = débito, salvo que `tipo` lo aclare. */
  monto: number;
  tipo?: TipoMovimientoExtraido;
  /** Número de comprobante/operación, si el extracto lo imprime. */
  numeroComprobante?: string;
  /** Saldo en cuenta que el extracto declara para ESTA fila, si el banco lo imprime (ej. Santander sí). */
  saldoDespues?: number;
}

/** Cuenta contable del plan del cliente, tal como se le pasa a la IA de contexto (nunca un id de Mongo). */
export interface CuentaContableDisponible {
  codigo: string;
  nombre: string;
  naturaleza: 'deudora' | 'acreedora';
}

/** Regla de clasificación ya activa, de contexto — para que la IA no repita sugerencias ya cubiertas. */
export interface ReglaExistenteResumen {
  patronTexto?: string;
  /** Si la regla solo aplica a débitos o a créditos — sin esto la IA creía cubierto, p. ej., un "Pago comercios" débito por existir la regla de créditos. */
  tipoMovimiento?: TipoMovimientoExtraido;
  cuentaCodigo: string;
}

/**
 * Regla de clasificación inferida por la IA a partir de un patrón recurrente del
 * extracto que pudo mapear con confianza a una cuenta YA EXISTENTE del cliente
 * (nunca inventa cuentas nuevas). Se resuelve contra `CuentaContableDisponible.codigo`
 * — `ExtractosIaProcessor` es quien la convierte en una `ReglaClasificacion` real.
 */
export interface ReglaClasificacionSugerida {
  /** Porción genérica y reconocible del concepto — no la fila completa (tiene que servir en extractos futuros). */
  patronTexto: string;
  /** Código EXACTO de una cuenta de `CuentaContableDisponible[]` — si no matchea ninguna, se descarta. */
  cuentaCodigo: string;
  ladoAsiento: 'debe' | 'haber';
  tipoMovimiento?: TipoMovimientoExtraido;
}

export interface ExtraccionResultado {
  /** true si el adapter pudo extraer movimientos del PDF. */
  exitoso: boolean;
  /** Movimientos extraídos, en el mismo orden en que aparecen en el extracto. Vacío si `exitoso` es false. */
  movimientos: MovimientoExtraido[];
  /** Saldo inicial declarado en el encabezado del extracto (ej. fila "Saldo Inicial"), si el banco lo imprime. */
  saldoInicialDeclarado?: number;
  /** Saldo final declarado al pie/resumen del extracto, si el banco lo imprime. */
  saldoFinalDeclarado?: number;
  /**
   * Reglas de clasificación inferidas para patrones recurrentes del extracto.
   * Vacío si no se pidió inferencia (no se pasó `cuentasContablesDisponibles`
   * en el input) o si la IA no encontró ningún patrón mapeable con confianza.
   */
  reglasSugeridas: ReglaClasificacionSugerida[];
  /**
   * Mensaje legible para humanos. Se usa tanto para detalle de éxito como,
   * sobre todo, para casos de error (ej. "PDF sin capa de texto, probablemente
   * escaneado" — checklist FOLGAR-010: "Detectar PDFs sin capa de texto").
   */
  mensaje?: string;
}

export interface AiExtractionInput {
  nombreArchivo: string;
  /** Texto plano del PDF, ya extraído por `PdfTextExtractorService` — nunca el binario. */
  texto: string;
  /**
   * Presente solo en el reintento acotado (máx. 1) que dispara
   * `ExtractosIaService` cuando la validación de saldo fila por fila
   * encuentra diferencias: describe qué filas no cuadraron y qué saldo se
   * esperaba, para que el adapter pueda pedirle a la IA que las revise sin
   * reprocesar el documento completo de nuevo.
   */
  pistaRevision?: string;
  /**
   * Plan de cuentas activo del cliente — si viene, el adapter le pide a la IA
   * que además infiera reglas de clasificación (`reglasSugeridas`) para
   * patrones que mapeen con confianza a una de estas cuentas. Se omite en el
   * reintento por diferencia de saldo (no hace falta volver a pedirlas).
   */
  cuentasContablesDisponibles?: CuentaContableDisponible[];
  /** Reglas ya activas del cliente/cuenta bancaria — para que la IA no repita sugerencias. */
  reglasExistentes?: ReglaExistenteResumen[];
}

/**
 * Credencial resuelta por `AiProviderResolverService` (Configuración →
 * Integraciones) para esta llamada puntual. Si `apiKey` viene vacía, el
 * adapter cae a su propia `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` de entorno
 * (constructor) — comportamiento previo a Configuración, intacto.
 */
export interface AiCredenciales {
  apiKey?: string;
  modelo?: string;
}

export interface AiExtractionPort {
  extraerMovimientos(
    input: AiExtractionInput,
    credenciales?: AiCredenciales,
  ): Promise<ExtraccionResultado>;
}

/**
 * Token de inyección de dependencias para `AiExtractionPort`. Se inyecta con
 * `@Inject(AI_EXTRACTION_PORT)` en vez de acoplarse a un adapter concreto.
 */
export const AI_EXTRACTION_PORT = Symbol('AI_EXTRACTION_PORT');
