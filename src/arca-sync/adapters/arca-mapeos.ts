import type {
  ArcaComprobante,
  ArcaPresentacion,
  ArcaVencimiento,
  ArcaDeuda,
  ArcaVep,
} from '../ports/arca-portal.port';

/**
 * Traducción de las respuestas JSON reales de ARCA a los 4 bloques de la
 * pestaña ARCA. Funciones puras (sin navegador) para poder probarlas con
 * respuestas tal como las devuelve ARCA — ver `arca-mapeos.spec.ts`.
 */

/** `GET portalcf.cloud.afip.gob.ar/portal/api/vencimientos/{cuit}` (agenda del portal). */
export interface PortalVencimiento {
  idImpuesto: number;
  periodo: number; // 202500 = anual 2025, 202609 = septiembre 2026
  anticipoCuota: number;
  tipoOperacion: 'PAGO' | 'PRESENTACION' | string;
  vencimiento: number; // epoch ms
  formularios?: string;
  descImpuesto: string;
  descConcepto: string;
}

/** `GET seti.afip.gob.ar/setiweb/api/presentaciones/` → `data.resultados[]`. */
export interface SetiPresentacion {
  estado: number; // 1 aceptada, 0 pendiente, -1 enviada
  formulario: string; // "F711 v2800"
  periodo: string; // "2025-00"
  fechaPresentacion?: string; // "2026-09-18 14:44:27.000" (hora argentina)
}

/** `GET seti.afip.gob.ar/setiweb/api/pagos` → `data.vepsConsultados[]`. */
export interface SetiVep {
  estado: number;
  nroVep: number;
  importe: number;
  descripcion: string;
  fechaDePago?: string | null;
  fechaGeneracion?: string | null;
  fechaExpiracion?: string | null;
  fechaVencimiento?: string | null;
  periodo?: string | null;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/** Formularios conocidos → impuesto, para las DDJJ que no aparecen en la agenda. */
const IMPUESTO_POR_FORMULARIO: Record<string, string> = {
  '711': 'Ganancias Personas Humanas',
  '713': 'Ganancias Sociedades',
  '2002': 'IVA',
  '2051': 'IVA',
  '731': 'IVA',
  '810': 'IVA',
  '931': 'Seguridad Social (SUSS)',
  '762': 'Bienes Personales',
  '2031': 'Bienes Personales',
};

/** "F711 v2800" → "711". */
export function numeroFormulario(formulario: string): string {
  return formulario.match(/\d+/)?.[0] ?? formulario;
}

/** 202500 → "2025"; 202609 → "2026-09". */
function periodoPortal(periodo: number): string {
  const anio = Math.floor(periodo / 100);
  const mes = periodo % 100;
  return mes === 0 ? String(anio) : `${anio}-${String(mes).padStart(2, '0')}`;
}

/** "2025-00" → "2025"; "2026-09" → "2026-09". */
function periodoSeti(periodo: string): string {
  return periodo.endsWith('-00') ? periodo.slice(0, 4) : periodo;
}

/** "2026-09-18 14:44:27.000" (hora argentina) → ISO. */
export function fechaSeti(fecha?: string | null): string | undefined {
  if (!fecha) return undefined;
  const limpia = fecha.trim().replace(' ', 'T').replace(/\.\d+$/, '');
  const d = new Date(`${/^\d{4}-\d{2}-\d{2}$/.test(limpia) ? `${limpia}T00:00:00` : limpia}-03:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** "03/06/2026" → ISO (medianoche argentina). */
function fechaDdMmYyyy(fecha: string): string {
  const [d, m, y] = fecha.split('/');
  return new Date(`${y}-${m}-${d}T00:00:00-03:00`).toISOString();
}

/** Clave para cruzar una DDJJ presentada con su vencimiento de presentación. */
function clavePresentacion(formulario: string, periodo: string): string {
  return `${numeroFormulario(formulario)}|${periodo}`;
}

export function presentacionesAceptadas(presentadas: SetiPresentacion[]): Set<string> {
  return new Set(
    presentadas.filter((p) => p.estado === 1).map((p) => clavePresentacion(p.formulario, periodoSeti(p.periodo))),
  );
}

export function mapearVencimientos(
  agenda: PortalVencimiento[],
  aceptadas: Set<string>,
  hoy = new Date(),
): ArcaVencimiento[] {
  return agenda
    .map((v) => {
      const periodo = periodoPortal(v.periodo);
      const esPresentacion = v.tipoOperacion === 'PRESENTACION';
      const cumplido =
        esPresentacion &&
        (v.formularios ?? '').split(/[,\s]+/).some((f) => f && aceptadas.has(clavePresentacion(f, periodo)));
      const dias = (v.vencimiento - hoy.getTime()) / DIA_MS;
      const estado: ArcaVencimiento['estado'] = cumplido
        ? 'cumplido'
        : dias < 0
          ? 'vencido'
          : dias <= 7
            ? 'pendiente'
            : 'proximo';
      const cuota = v.anticipoCuota > 0 ? ` — cuota ${v.anticipoCuota}` : '';
      return {
        concepto: `${capitalizar(v.descConcepto)}${cuota} (${esPresentacion ? 'presentación' : 'pago'})`,
        impuesto: capitalizar(v.descImpuesto),
        periodo,
        fecha: new Date(v.vencimiento).toISOString(),
        estado,
      };
    })
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/**
 * DDJJ presentadas (SETI) + pendientes: las que SETI informa como falta de
 * presentación y los vencimientos de presentación de la agenda todavía sin
 * una DDJJ aceptada.
 */
export function mapearPresentaciones(
  presentadas: SetiPresentacion[],
  faltaPresentacion: Record<string, unknown>[],
  agenda: PortalVencimiento[],
  aceptadas: Set<string>,
): ArcaPresentacion[] {
  const impuestoPorFormulario = new Map(Object.entries(IMPUESTO_POR_FORMULARIO));
  for (const v of agenda) {
    for (const f of (v.formularios ?? '').split(/[,\s]+/).filter(Boolean)) {
      impuestoPorFormulario.set(f, capitalizar(v.descImpuesto));
    }
  }
  const impuestoDe = (formulario: string) =>
    impuestoPorFormulario.get(numeroFormulario(formulario)) ?? `Formulario ${numeroFormulario(formulario)}`;

  const resultado: ArcaPresentacion[] = presentadas.map((p) => ({
    impuesto: impuestoDe(p.formulario),
    formulario: p.formulario,
    periodo: periodoSeti(p.periodo),
    fechaPresentacion: fechaSeti(p.fechaPresentacion),
    estado: p.estado === 1 ? 'presentada' : 'pendiente',
  }));

  const pendientesVistas = new Set<string>();
  for (const f of faltaPresentacion) {
    const formulario = texto(f.formulario ?? f.nroFormulario ?? f.codigoFormulario);
    const periodoTexto = texto(f.periodo ?? f.periodoFiscal);
    const periodo = periodoTexto ? periodoNumerico(periodoTexto) : '—';
    // SETI manda el impuesto como `{ codigo, descripcion }`; Cuentas Tributarias, en `descImpuesto`.
    const impuestoObjeto = typeof f.impuesto === 'object' && f.impuesto ? (f.impuesto as Record<string, unknown>) : null;
    const impuesto =
      capitalizar(
        texto(f.descImpuesto ?? f.impuestoDescripcion ?? f.descripcionImpuesto ?? impuestoObjeto?.descripcion),
      ) || (formulario ? impuestoDe(formulario) : 'Sin detalle');
    const concepto = texto(f.descConcepto);
    // SETI y Cuentas Tributarias informan las mismas DDJJ faltantes (con el nombre del
    // impuesto escrito distinto): se cruzan por código de impuesto + concepto + período.
    const codigoImpuesto = texto(impuestoObjeto?.codigo ?? (impuestoObjeto ? '' : f.impuesto)) || impuesto;
    const clave = `${codigoImpuesto}|${texto(f.concepto)}|${periodo}`;
    if (pendientesVistas.has(clave)) continue;
    pendientesVistas.add(clave);
    resultado.push({
      impuesto: concepto && !/declaraci[oó]n jurada/i.test(concepto) ? `${impuesto} — ${capitalizar(concepto)}` : impuesto,
      formulario: formulario || undefined,
      periodo,
      fechaVencimiento:
        typeof f.fechaVencimiento === 'number'
          ? new Date(f.fechaVencimiento).toISOString()
          : fechaSeti(texto(f.fechaVencimientoAsString ?? f.fechaVencimiento ?? f.vencimiento)),
      estado: 'pendiente',
    });
  }

  for (const v of agenda.filter((a) => a.tipoOperacion === 'PRESENTACION')) {
    const periodo = periodoPortal(v.periodo);
    const formularios = (v.formularios ?? '').split(/[,\s]+/).filter(Boolean);
    if (formularios.some((f) => aceptadas.has(clavePresentacion(f, periodo)))) continue;
    const yaListada = resultado.some(
      (r) => r.estado === 'pendiente' && r.periodo === periodo && formularios.includes(numeroFormulario(r.formulario ?? '')),
    );
    if (yaListada) continue;
    resultado.push({
      impuesto: capitalizar(v.descImpuesto),
      formulario: formularios.length ? `F${formularios.join(', F')}` : undefined,
      periodo,
      fechaVencimiento: new Date(v.vencimiento).toISOString(),
      estado: 'pendiente',
    });
  }

  // Pendientes primero, después las presentadas de la más nueva a la más vieja.
  return resultado.sort((a, b) =>
    a.estado !== b.estado
      ? a.estado === 'pendiente'
        ? -1
        : 1
      : (b.fechaPresentacion ?? b.periodo).localeCompare(a.fechaPresentacion ?? a.periodo),
  );
}

export function mapearVeps(veps: SetiVep[], hoy = new Date()): ArcaVep[] {
  return veps.map((v) => {
    const vence = fechaSeti(v.fechaExpiracion ?? v.fechaVencimiento);
    const estado: ArcaVep['estado'] = v.fechaDePago
      ? 'pagado'
      : vence && new Date(vence) < hoy
        ? 'vencido'
        : 'pendiente';
    return {
      numero: String(v.nroVep),
      impuesto: v.descripcion,
      periodo: v.periodo ? periodoSeti(v.periodo) : undefined,
      importe: v.importe,
      fechaGeneracion: fechaSeti(v.fechaGeneracion),
      fechaVencimiento: vence,
      fechaPago: fechaSeti(v.fechaDePago),
      estado,
    };
  });
}

/**
 * Fila de `mcmp/jsp/ajax.do?f=listaResultados` (Mis Comprobantes). Emitidos y
 * recibidos tienen distinta cantidad de columnas en el medio, pero comparten
 * el principio (fecha, tipo, punto de venta, número, CUIT y razón social de
 * la contraparte en 11/12) y el final (IVA total en -4, importe total en -2).
 */
export function mapearComprobante(
  fila: (string | null)[],
  tipo: 'venta' | 'compra',
  clases: Map<string, string>,
): ArcaComprobante {
  const fecha = fechaDdMmYyyy(fila[0] ?? '');
  const [, mes, anio] = (fila[0] ?? '').split('/');
  const codigo = fila[1] ?? '';
  return {
    tipo,
    clase: (clases.get(codigo) ?? `Tipo ${codigo}`).trim(),
    fecha,
    periodo: `${anio}-${mes}`,
    puntoVenta: fila[3] ? Number(fila[3]) : undefined,
    numero: fila[4] ?? undefined,
    cuitContraparte: fila[11] ?? '',
    razonSocialContraparte: fila[12] ?? undefined,
    importeTotal: Number(fila[fila.length - 2] ?? 0),
    iva: Number(fila[fila.length - 4] ?? 0),
  };
}

function capitalizar(textoArca: string): string {
  const t = textoArca.trim().toLowerCase();
  // Siglas del dominio en mayúscula, como en el resto de la plataforma.
  return (t.charAt(0).toUpperCase() + t.slice(1)).replace(/\b(iva|suss|ddjj|arca|cuit)\b/gi, (s) => s.toUpperCase());
}

/**
 * Períodos de SETI/Cuentas Tributarias: "2025-00" o 2025 (anual), 202408 (mensual),
 * 20260900 (mensual con día en 00).
 */
function periodoNumerico(periodo: string): string {
  if (/^\d{4}-\d{2}$/.test(periodo)) return periodoSeti(periodo);
  const digitos = periodo.replace(/\D/g, '');
  if (digitos.length === 8) return periodoNumerico(digitos.slice(0, 6));
  if (digitos.length === 6) {
    const mes = digitos.slice(4, 6);
    return mes === '00' ? digitos.slice(0, 4) : `${digitos.slice(0, 4)}-${mes}`;
  }
  return periodo;
}

/** Cuentas Tributarias a veces devuelve un objeto suelto en vez de una lista de uno. */
export function comoLista<T>(valor: T | T[] | null | undefined | ''): T[] {
  if (!valor) return [];
  return Array.isArray(valor) ? valor : [valor];
}

/**
 * `HomeContribuyenteViewService.getDeudas(cuit, null)` de Cuentas Tributarias
 * ("Estado de cuenta" → pestaña Deudas), intereses calculados al día.
 */
export function mapearDeudas(deudas: Record<string, unknown>[], hoy = new Date()): ArcaDeuda[] {
  return deudas
    .map((d) => {
      const fechaVencimiento = fechaSeti(texto(d.fechaVencimiento));
      return {
        impuesto: texto(d.impuestoView) || texto(d.descImpuesto),
        concepto: texto(d.conceptoView) || texto(d.descConcepto),
        subconcepto: texto(d.subconceptoView) || texto(d.descSubconcepto),
        periodo: periodoNumerico(texto(d.periodoFiscal)),
        anticipoCuota: Number(d.anticipocuota ?? 0),
        fechaVencimiento,
        saldo: Number(d.importe ?? 0),
        interesesResarcitorios: Number(d.importeInteresesResarcitorios ?? 0),
        interesesPunitorios: Number(d.importeInteresesPunitorios ?? 0),
        vencida: fechaVencimiento ? new Date(fechaVencimiento) < hoy : false,
      };
    })
    .sort((a, b) => (a.fechaVencimiento ?? '').localeCompare(b.fechaVencimiento ?? ''));
}

/**
 * `getVencimientos(cuit)` de Cuentas Tributarias — se usa para los representados,
 * porque la agenda del portal solo responde para el CUIT con el que se entró.
 */
export function mapearVencimientosCtacte(vencimientos: Record<string, unknown>[], hoy = new Date()): ArcaVencimiento[] {
  return vencimientos
    .map((v) => {
      const fecha = fechaSeti(texto(v.fechaVencimiento)) ?? new Date().toISOString();
      const dias = (new Date(fecha).getTime() - hoy.getTime()) / DIA_MS;
      const cuota = Number(v.anticipoCuota ?? 0);
      const operacion = texto(v.tipoOperacion).toLowerCase();
      return {
        concepto: `${capitalizar(texto(v.descConcepto))}${cuota > 0 ? ` — cuota ${cuota}` : ''}${operacion ? ` (${operacion})` : ''}`,
        impuesto: capitalizar(texto(v.descImpuesto)),
        periodo: periodoNumerico(texto(v.periodoFiscal)),
        fecha,
        estado: (dias < 0 ? 'vencido' : dias <= 7 ? 'pendiente' : 'proximo') as ArcaVencimiento['estado'],
      };
    })
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

function texto(valor: unknown): string {
  return valor === null || valor === undefined ? '' : String(valor).trim();
}
