/**
 * Puerto de acceso al portal de ARCA con la clave fiscal de un cliente
 * (patrón puerto/adapter, mismo criterio que `ArcaMonitorPort`).
 * `ArcaSyncService` depende solo de esta interfaz, inyectada con
 * `ARCA_PORTAL_PORT`.
 *
 * Los 4 bloques son los que pidió el usuario para la pestaña ARCA de
 * "Notificaciones": Vencimientos, Comprobantes, VEP y pagos, Presentaciones.
 * Cada bloque es `null` mientras el adapter todavía no sepa leerlo de ARCA —
 * distinto de `[]`, que significa "se leyó y no hay nada".
 */
export interface ArcaCredenciales {
  /** CUIT/CUIL con el que se entra a ARCA, solo dígitos. */
  cuit: string;
  password: string;
}

/** Agenda de vencimientos de ARCA. */
export interface ArcaVencimiento {
  concepto: string;
  impuesto?: string;
  periodo?: string;
  fecha: string; // ISO
  importe?: number;
  estado: 'pendiente' | 'proximo' | 'vencido' | 'cumplido';
}

/** Portal IVA / Mis Comprobantes: emitidos (venta) y recibidos (compra) juntos. */
export interface ArcaComprobante {
  tipo: 'venta' | 'compra';
  /** Ej. "Factura A", "Nota de crédito B". */
  clase: string;
  fecha: string; // ISO
  periodo: string; // YYYY-MM
  puntoVenta?: number;
  numero?: string;
  cuitContraparte: string;
  razonSocialContraparte?: string;
  importeTotal: number;
  iva: number;
}

/** VEP generados para el contribuyente (incluso por terceros). */
export interface ArcaVep {
  numero: string;
  impuesto: string;
  periodo?: string;
  importe: number;
  fechaGeneracion?: string; // ISO
  fechaPago?: string; // ISO
  fechaVencimiento?: string; // ISO
  estado: 'generado' | 'pendiente' | 'pagado' | 'vencido';
}

/** DDJJ presentadas y pendientes (Cuentas Tributarias / Presentación de DDJJ y Pagos). */
export interface ArcaPresentacion {
  impuesto: string;
  formulario?: string;
  periodo: string;
  fechaPresentacion?: string; // ISO
  fechaVencimiento?: string; // ISO
  estado: 'presentada' | 'pendiente';
}

/** Deuda del Sistema de Cuentas Tributarias ("Estado de cuenta"), con intereses calculados al día. */
export interface ArcaDeuda {
  impuesto: string;
  concepto: string;
  subconcepto: string;
  periodo: string;
  anticipoCuota: number;
  fechaVencimiento?: string; // ISO
  saldo: number;
  interesesResarcitorios: number;
  interesesPunitorios: number;
  vencida: boolean;
}

export type ArcaBloque = 'vencimientos' | 'deudas' | 'comprobantes' | 'veps' | 'presentaciones';

export interface ArcaDatos {
  vencimientos: ArcaVencimiento[] | null;
  deudas: ArcaDeuda[] | null;
  comprobantes: ArcaComprobante[] | null;
  veps: ArcaVep[] | null;
  presentaciones: ArcaPresentacion[] | null;
  /** Por qué un bloque quedó en `null` (ej. ARCA no ofrece ese servicio para este CUIT). */
  notas: Partial<Record<ArcaBloque, string>>;
}

export const ARCA_DATOS_VACIOS: ArcaDatos = {
  vencimientos: null,
  deudas: null,
  comprobantes: null,
  veps: null,
  presentaciones: null,
  notas: {},
};

/** El propio cliente y las personas que representa en ARCA (ej. una sociedad). */
export interface ArcaContribuyente {
  cuit: string;
  nombre: string;
}

export interface ArcaSincronizacionResultado {
  /** El primero es siempre el CUIT con el que se entró (el propio cliente). */
  contribuyentes: ArcaContribuyente[];
  datosPorCuit: Record<string, ArcaDatos>;
}

export interface ArcaPortalPort {
  sincronizar(credenciales: ArcaCredenciales): Promise<ArcaSincronizacionResultado>;
}

export const ARCA_PORTAL_PORT = Symbol('ARCA_PORTAL_PORT');
