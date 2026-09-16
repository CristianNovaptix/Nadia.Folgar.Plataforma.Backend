import { LadoAsiento } from '../../reglas-clasificacion/schemas/regla-clasificacion.schema';

/**
 * Puerto de sincronización con Catedral (patrón puerto/adapter — ver ADR #5 en
 * CLAUDE.md: "Puerto/adapter para toda integración externa").
 *
 * Catedral es el sistema contable/impositivo que el estudio ya usa y no se
 * reemplaza. Al día de hoy (FOLGAR-029) todavía NO está decidido si la
 * integración va a ser por API, por exportación/importación de archivos, o
 * por otra vía — esa decisión depende de una conversación con el cliente que
 * todavía no pasó. Por eso este contrato se mantiene deliberadamente mínimo y
 * genérico: modela las operaciones que probablemente se van a necesitar
 * independientemente de la vía elegida, sin comprometerse a ninguna.
 *
 * `CatedralService` depende únicamente de esta interfaz, inyectada vía el
 * token `CATEDRAL_SYNC_PORT` (nunca de una clase concreta). El día de mañana
 * se puede escribir un `CatedralApiAdapter` o un `CatedralFileAdapter` real
 * que implemente este mismo puerto sin tocar el resto del sistema — alcanza
 * con cambiar el `useClass` del provider en `catedral.module.ts`.
 */
export interface SyncResult {
  /** true si el adapter considera la operación exitosa. */
  exitoso: boolean;
  /** Mensaje legible para humanos — se persiste como `detalle` en CatedralSyncLog. */
  mensaje: string;
  /** Datos adicionales opcionales devueltos por el adapter (conteos, ids, etc.). */
  datos?: Record<string, unknown>;
}

/** Input de `exportarAsientoContable`: qué extracto exportar, más las resoluciones manuales de movimientos que ninguna regla clasificó. */
export interface AsientoContableExportInput {
  extractoId: string;
  estudioId: string;
  asignacionesManuales?: {
    movimientoId: string;
    cuentaContableId: string;
    ladoAsiento: LadoAsiento;
  }[];
}

export interface ArchivoGenerado {
  nombreArchivo: string;
  contentType: string;
  contenidoBase64: string;
}

export interface AsientoContableExportResult extends SyncResult {
  /** Presente solo cuando `exitoso` es `true`. */
  archivo?: ArchivoGenerado;
  /**
   * Presente cuando `exitoso` es `false` por una validación contable (algún
   * mes no cuadra / quedan movimientos sin clasificar) — un extracto de más
   * de un mes calendario arma un asiento por mes (ver
   * `construirAsientosMensuales`), así que la validación es por mes, no
   * global.
   */
  validacion?: {
    meses: {
      periodo: string;
      cuadra: boolean;
      sinClasificar: { movimientoId: string; concepto: string; monto: number }[];
    }[];
  };
}

export interface CatedralSyncPort {
  /** Exporta el maestro de clientes del estudio hacia Catedral (o lo que la vía elegida requiera). */
  exportarClientes(): Promise<SyncResult>;

  /**
   * Importa movimientos/datos desde Catedral. `origen` es intencionalmente
   * `unknown`: según la vía que se defina en FOLGAR-029 puede terminar siendo
   * un archivo, una respuesta de API, una ruta a un export, etc. El puerto no
   * prejuzga el formato.
   */
  importarMovimientos(origen: unknown): Promise<SyncResult>;

  /**
   * Arma el asiento contable de un extracto y genera el archivo listo para
   * importar en Catedral vía "Asientos por lote → Importar desde archivo"
   * (ver instructivo interno del estudio). Método propio, no una
   * reinterpretación de `importarMovimientos`: esa operación fue diseñada
   * para el sentido contrario (traer datos DESDE Catedral, según su propio
   * contrato `SyncResult`) y no representa bien un archivo binario más
   * errores de validación contable estructurados.
   */
  exportarAsientoContable(input: AsientoContableExportInput): Promise<AsientoContableExportResult>;
}

/**
 * Token de inyección de dependencias para `CatedralSyncPort`. Se inyecta con
 * `@Inject(CATEDRAL_SYNC_PORT)` en vez de acoplarse a un adapter concreto.
 */
export const CATEDRAL_SYNC_PORT = Symbol('CATEDRAL_SYNC_PORT');
