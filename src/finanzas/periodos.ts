/**
 * Meses ("períodos", AAAA-MM) siempre en hora de Argentina (UTC-3, sin
 * horario de verano): el servidor corre en UTC y, sin esto, lo cargado el
 * día 1 a la madrugada caería en el mes anterior.
 */
const TZ = 'America/Argentina/Buenos_Aires';

export function periodoDe(fecha: Date): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(fecha);
  const anio = partes.find((p) => p.type === 'year')!.value;
  const mes = partes.find((p) => p.type === 'month')!.value;
  return `${anio}-${mes}`;
}

/** Primer instante del mes, en hora de Argentina. */
export function inicioDePeriodo(periodo: string): Date {
  return new Date(`${periodo}-01T00:00:00-03:00`);
}

export function sumarMeses(periodo: string, cantidad: number): string {
  const [anio, mes] = periodo.split('-').map(Number);
  const total = anio * 12 + (mes - 1) + cantidad;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Cuántos meses hay de `desde` a `hasta` (0 si es el mismo mes). */
export function mesesEntre(desde: string, hasta: string): number {
  const [a1, m1] = desde.split('-').map(Number);
  const [a2, m2] = hasta.split('-').map(Number);
  return (a2 - a1) * 12 + (m2 - m1);
}

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** "noviembre 2026" */
export function nombrePeriodo(periodo: string): string {
  const [anio, mes] = periodo.split('-').map(Number);
  return `${MESES[mes - 1]} ${anio}`;
}

/** Una fecha sin hora ("2026-11-05") se toma como el mediodía de ese día en Argentina. */
export function fechaDePago(valor?: string): Date {
  if (!valor) return new Date();
  return /^\d{4}-\d{2}-\d{2}$/.test(valor) ? new Date(`${valor}T12:00:00-03:00`) : new Date(valor);
}

/**
 * Último momento para pagar la deuda de un mes: el día `dia` de ese mes, a
 * las 23:59 de Argentina. Si el mes no tiene ese día (ej. 31 en febrero), el
 * último día del mes.
 */
export function vencimientoDe(periodo: string, dia: number): Date {
  const [anio, mes] = periodo.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const diaReal = String(Math.min(dia, ultimoDia)).padStart(2, '0');
  return new Date(`${periodo}-${diaReal}T23:59:59-03:00`);
}

/**
 * Plazo de pago por defecto de todos los clientes: del día 1 al día 10 de
 * cada mes (pedido explícito del usuario). Cada cliente puede tener el suyo.
 */
export const DIA_INICIO_PAGO_DEFECTO = 1;
export const DIA_VENCIMIENTO_DEFECTO = 10;

/**
 * Plazo para pagar la deuda de un mes: desde el día `desde` hasta el día
 * `hasta`. Si `hasta` es menor que `desde` (ej. del 15 al 5), vence el mes
 * siguiente.
 */
export function plazoDePago(
  periodo: string,
  desde: number,
  hasta: number,
): { inicio: Date; fin: Date } {
  const [anio, mes] = periodo.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const diaInicio = String(Math.min(desde, ultimoDia)).padStart(2, '0');
  return {
    inicio: new Date(`${periodo}-${diaInicio}T00:00:00-03:00`),
    fin: vencimientoDe(hasta < desde ? sumarMeses(periodo, 1) : periodo, hasta),
  };
}

export function redondear(monto: number): number {
  return Math.round((monto + Number.EPSILON) * 100) / 100;
}
