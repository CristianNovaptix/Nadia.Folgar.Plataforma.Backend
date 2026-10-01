export type LadoAsientoLogic = 'debe' | 'haber';

export interface CondicionMontoLogic {
  operador: 'igual' | 'entre';
  valor?: number;
  valorMin?: number;
  valorMax?: number;
}

export interface MovimientoParaClasificar {
  _id: string;
  concepto: string;
  monto: number;
  tipo?: 'debito' | 'credito';
  /** Texto tal como lo extrajo la IA (ej. "31/01/25") — usado para agrupar por mes, ver `agruparMovimientosPorMes`. */
  fecha?: string;
  /** Saldo corrido después de este movimiento (ya calculado por `ExtractosIaService`) — cierre del mes si es el último movimiento del período. */
  saldoCalculado?: number;
}

export interface ReglaParaClasificar {
  _id: string;
  cuentaBancariaId?: string;
  patronTexto?: string;
  condicionMonto?: CondicionMontoLogic;
  tipoMovimiento?: 'debito' | 'credito';
  cuentaContableId: string;
  ladoAsiento: LadoAsientoLogic;
  prioridad: number;
  activa: boolean;
  /** 'manual' | 'aprendida' | 'ia' — a igual prioridad, una regla cargada por una persona le gana a una de la IA. */
  procedencia?: string;
  /** Split porcentual — ver docstring de `ReglaClasificacion` en el schema del Backend. */
  cuentaContableSecundariaId?: string;
  porcentajeSecundario?: number;
}

export interface AsignacionManual {
  cuentaContableId: string;
  ladoAsiento: LadoAsientoLogic;
}

export interface SplitClasificado {
  cuentaContableId: string;
  porcentaje: number;
}

export interface MovimientoClasificado {
  movimiento: MovimientoParaClasificar;
  cuentaContableId: string | null;
  ladoAsiento: LadoAsientoLogic | null;
  reglaId: string | null;
  /** Presente cuando la regla ganadora reparte el movimiento por %, ver `construirLineasAsiento`. */
  split?: SplitClasificado;
}

export interface LineaAsiento {
  cuentaContableId: string;
  lado: LadoAsientoLogic;
  monto: number;
  movimientos: MovimientoClasificado[];
}

/**
 * Normaliza un texto para compararlo: minúsculas, sin tildes, y cualquier
 * puntuación/espacios repetidos colapsados a un único espacio — así "Débito
 * automático" o "Imp.afip:" matchean igual que "Debito automatico" / "Imp afip".
 * Mirror de `normalizarTexto` en `extractos-ia/clasificacion.ts` del Frontend.
 */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();
}

/**
 * ¿El concepto contiene el patrón? Comparación normalizada; un `*` en el
 * patrón significa "cualquier texto en el medio" (para saltear fechas o
 * números de operación que cambian cada mes). Un patrón hecho solo de signos
 * no reconoce nada. Mirror de `patronCoincide` en `extractos-ia/clasificacion.ts` del Frontend.
 */
export function patronCoincide(patronTexto: string, concepto: string): boolean {
  const partes = patronTexto.split('*').map(normalizarTexto).filter(Boolean);
  if (partes.length === 0) return false;
  const texto = normalizarTexto(concepto);
  let desde = 0;
  for (const parte of partes) {
    const posicion = texto.indexOf(parte, desde);
    if (posicion === -1) return false;
    desde = posicion + parte.length;
  }
  return true;
}

/**
 * Menor `prioridad` primero; a igual prioridad, una regla cargada por una
 * persona (manual/aprendida) le gana a una de la IA; y después la más específica
 * (patrón más largo, después la que filtra por monto o tipo) — así "Debito
 * automatico Afip" le gana a "Debito automatico" sin depender del orden en
 * que vinieron de la base. Mirror de `compararReglas` del Frontend.
 */
function compararReglas(a: ReglaParaClasificar, b: ReglaParaClasificar): number {
  if (a.prioridad !== b.prioridad) return a.prioridad - b.prioridad;
  const esIa = (r: ReglaParaClasificar) => (r.procedencia === 'ia' ? 1 : 0);
  if (esIa(a) !== esIa(b)) return esIa(a) - esIa(b);
  const especificidad = (r: ReglaParaClasificar) =>
    normalizarTexto(r.patronTexto ?? '').length * 4 +
    (r.condicionMonto ? 2 : 0) +
    (r.tipoMovimiento ? 1 : 0);
  return especificidad(b) - especificidad(a);
}

function reglaAplica(
  regla: ReglaParaClasificar,
  movimiento: MovimientoParaClasificar,
  cuentaBancariaId: string,
): boolean {
  if (regla.cuentaBancariaId && regla.cuentaBancariaId !== cuentaBancariaId) {
    return false;
  }

  if (regla.patronTexto && !patronCoincide(regla.patronTexto, movimiento.concepto)) {
    return false;
  }

  if (regla.condicionMonto) {
    const { operador, valor, valorMin, valorMax } = regla.condicionMonto;
    if (operador === 'igual' && Math.abs(movimiento.monto - (valor ?? NaN)) > 0.01) {
      return false;
    }
    if (
      operador === 'entre' &&
      (movimiento.monto < (valorMin ?? -Infinity) || movimiento.monto > (valorMax ?? Infinity))
    ) {
      return false;
    }
  }

  if (regla.tipoMovimiento && regla.tipoMovimiento !== movimiento.tipo) {
    return false;
  }

  return true;
}

/**
 * Port 1:1 del motor de clasificación del Frontend
 * (`extractos-ia/clasificacion.ts` — `clasificarMovimientos`), para que el
 * armado del asiento que se exporta a Catedral no dependa del estado del
 * navegador. Además de las reglas activas del cliente, acepta un mapa de
 * `asignacionesManuales` (por `movimientoId`) que SIEMPRE tiene prioridad
 * sobre la regla que hubiera matcheado — no es solo para completar
 * movimientos que ninguna regla clasificó, es la vía para que el contador
 * rectifique a mano una fila que una regla clasificó mal (mismo rol que
 * `asignacionesLocales`/`ladosLocales`, compartido entre "Movimientos" y
 * "Asiento contable" en `ExtractoDetailDialog.tsx`), validado y aplicado del
 * lado del servidor al exportar.
 */
export function clasificarMovimientos(
  movimientos: MovimientoParaClasificar[],
  reglas: ReglaParaClasificar[],
  cuentaBancariaId: string,
  asignacionesManuales: Map<string, AsignacionManual> = new Map(),
): MovimientoClasificado[] {
  const reglasActivas = reglas
    .filter((r) => r.activa)
    .slice()
    .sort(compararReglas);

  return movimientos.map((movimiento) => {
    /** La corrección manual del contador siempre pisa a la regla — es la vía para rectificar una fila mal clasificada, no solo para completar las que no matchearon ninguna. */
    const asignacionManual = asignacionesManuales.get(movimiento._id);
    if (asignacionManual) {
      return {
        movimiento,
        cuentaContableId: asignacionManual.cuentaContableId,
        ladoAsiento: asignacionManual.ladoAsiento,
        reglaId: null,
      };
    }

    const reglaGanadora = reglasActivas.find((r) => reglaAplica(r, movimiento, cuentaBancariaId));
    if (reglaGanadora) {
      return {
        movimiento,
        cuentaContableId: reglaGanadora.cuentaContableId,
        ladoAsiento: reglaGanadora.ladoAsiento,
        reglaId: reglaGanadora._id,
        split:
          reglaGanadora.cuentaContableSecundariaId &&
          reglaGanadora.porcentajeSecundario !== undefined
            ? {
                cuentaContableId: reglaGanadora.cuentaContableSecundariaId,
                porcentaje: reglaGanadora.porcentajeSecundario,
              }
            : undefined,
      };
    }

    return { movimiento, cuentaContableId: null, ladoAsiento: null, reglaId: null };
  });
}

/**
 * Arma las líneas Debe/Haber del asiento: cada movimiento clasificado postea
 * su monto a la cuenta que ganó la regla (o la asignación manual), agrupado
 * por (cuenta, lado). La cuenta bancaria NO se arma espejando cada
 * movimiento — se postea como una única línea "plug" igual a
 * `saldoFinalDeclarado - saldoInicialDeclarado` (Debe si el saldo subió,
 * Haber si bajó), reproduciendo el patrón verificado en el análisis forense
 * de los Excel "Asientos" reales del estudio: la cuenta del banco siempre es
 * una sola línea neta, nunca la suma de contrapartidas de cada movimiento.
 * Así "Total Debe = Total Haber" es una validación real de que la
 * clasificación reprodujo el movimiento neto real de la cuenta, no una
 * identidad garantizada por construcción.
 *
 * Sin `saldoInicialDeclarado`/`saldoFinalDeclarado` no se puede calcular el
 * plug — se devuelven solo las líneas clasificadas, sin la línea del banco.
 */
export function construirLineasAsiento(
  clasificados: MovimientoClasificado[],
  cuentaContableBancariaId: string,
  saldoInicialDeclarado?: number,
  saldoFinalDeclarado?: number,
): LineaAsiento[] {
  const lineas = new Map<string, LineaAsiento>();

  const acumular = (
    cuentaContableId: string,
    lado: LadoAsientoLogic,
    monto: number,
    item: MovimientoClasificado,
  ) => {
    const clave = `${cuentaContableId}:${lado}`;
    const linea = lineas.get(clave) ?? { cuentaContableId, lado, monto: 0, movimientos: [] };
    linea.monto += monto;
    linea.movimientos.push(item);
    lineas.set(clave, linea);
  };

  for (const item of clasificados) {
    if (!item.cuentaContableId || !item.ladoAsiento) continue;
    const montoTotal = Math.abs(item.movimiento.monto);

    if (item.split) {
      const montoSecundario = Math.round(montoTotal * (item.split.porcentaje / 100) * 100) / 100;
      const montoPrincipal = Math.round((montoTotal - montoSecundario) * 100) / 100;
      acumular(item.cuentaContableId, item.ladoAsiento, montoPrincipal, item);
      acumular(item.split.cuentaContableId, item.ladoAsiento, montoSecundario, item);
    } else {
      acumular(item.cuentaContableId, item.ladoAsiento, montoTotal, item);
    }
  }

  if (saldoInicialDeclarado !== undefined && saldoFinalDeclarado !== undefined) {
    const plug = Math.round((saldoFinalDeclarado - saldoInicialDeclarado) * 100) / 100;
    if (Math.abs(plug) > 0) {
      const lado: LadoAsientoLogic = plug > 0 ? 'debe' : 'haber';
      const clave = `${cuentaContableBancariaId}:${lado}`;
      // Si el contador reasignó movimientos a la propia cuenta del banco, el plug se suma a esa línea en vez de pisarla.
      const existente = lineas.get(clave);
      lineas.set(clave, {
        cuentaContableId: cuentaContableBancariaId,
        lado,
        monto: (existente?.monto ?? 0) + Math.abs(plug),
        movimientos: existente?.movimientos ?? [],
      });
    }
  }

  return Array.from(lineas.values());
}

/** "02/01/25" o "02/01/2025" -> "2025-01". `null` si no matchea el formato esperado. */
function periodoDeFecha(fecha: string): string | null {
  const match = fecha.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  const [, , mesStr, anioStr] = match;
  const mes = mesStr.padStart(2, '0');
  const anio = anioStr.length === 2 ? `20${anioStr}` : anioStr;
  return `${anio}-${mes}`;
}

/**
 * Agrupa los movimientos por mes calendario (según `fecha`), preservando el
 * orden de aparición de cada mes — un extracto que cruza fin de mes arma un
 * asiento por cada mes que contiene (ver `construirAsientosMensuales`), en
 * vez de uno solo para todo el rango. Los movimientos con fecha no parseable
 * (formato inesperado) caen en un grupo `SIN_FECHA` separado, para no
 * perderlos silenciosamente.
 */
export function agruparMovimientosPorMes<T extends MovimientoParaClasificar>(
  movimientos: T[],
): Map<string, T[]> {
  const grupos = new Map<string, T[]>();
  for (const movimiento of movimientos) {
    const periodo = (movimiento.fecha && periodoDeFecha(movimiento.fecha)) || 'SIN_FECHA';
    const lista = grupos.get(periodo) ?? [];
    lista.push(movimiento);
    grupos.set(periodo, lista);
  }
  return grupos;
}

export interface AsientoMensual {
  /** "YYYY-MM", o "SIN_FECHA" si hubo movimientos con fecha no parseable. */
  periodo: string;
  saldoInicial?: number;
  saldoFinal?: number;
  lineas: LineaAsiento[];
  clasificados: MovimientoClasificado[];
}

/**
 * Arma un asiento contable por cada mes calendario presente en el extracto
 * (checklist: "si un extracto abarca más de un mes, un asiento mensual por
 * cada rango"). El saldo inicial del primer mes es el del extracto; el de
 * cada mes siguiente es el saldo final calculado del mes anterior — así el
 * plug de cada mes (ver `construirLineasAsiento`) refleja el movimiento neto
 * real de ESE mes, no de todo el extracto.
 */
export function construirAsientosMensuales(
  movimientos: MovimientoParaClasificar[],
  reglas: ReglaParaClasificar[],
  cuentaBancariaId: string,
  cuentaContableBancariaId: string,
  saldoInicialExtracto: number | undefined,
  asignacionesManuales: Map<string, AsignacionManual> = new Map(),
): AsientoMensual[] {
  const grupos = agruparMovimientosPorMes(movimientos);
  const resultado: AsientoMensual[] = [];
  let saldoAnterior = saldoInicialExtracto;

  for (const [periodo, movimientosDelMes] of grupos) {
    const clasificados = clasificarMovimientos(
      movimientosDelMes,
      reglas,
      cuentaBancariaId,
      asignacionesManuales,
    );
    const ultimoConSaldo = [...movimientosDelMes]
      .reverse()
      .find((m) => m.saldoCalculado !== undefined);
    const saldoFinal = ultimoConSaldo?.saldoCalculado;

    const lineas = construirLineasAsiento(
      clasificados,
      cuentaContableBancariaId,
      saldoAnterior,
      saldoFinal,
    );

    resultado.push({ periodo, saldoInicial: saldoAnterior, saldoFinal, lineas, clasificados });
    saldoAnterior = saldoFinal ?? saldoAnterior;
  }

  return resultado;
}
