import {
  EstadoExtracto,
  MovimientoExtracto,
  TipoMovimiento,
  ValidacionSaldo,
} from './schemas/extracto-bancario.schema';

/** Tolerancia de redondeo para considerar que un saldo declarado y uno calculado coinciden. */
export const TOLERANCIA_SALDO = 0.01;

export interface MovimientoValidable {
  fecha: string;
  concepto: string;
  monto: number;
  tipo?: TipoMovimiento;
  numeroComprobante?: string;
  saldoDeclarado?: number;
}

function signedDelta(mov: { monto: number; tipo?: TipoMovimiento }): number {
  if (mov.tipo === TipoMovimiento.DEBITO) return -Math.abs(mov.monto);
  if (mov.tipo === TipoMovimiento.CREDITO) return Math.abs(mov.monto);
  return mov.monto;
}

function tipoOpuesto(tipo: TipoMovimiento): TipoMovimiento {
  return tipo === TipoMovimiento.DEBITO ? TipoMovimiento.CREDITO : TipoMovimiento.DEBITO;
}

function redondear(valor: number): number {
  return Math.round(valor * 100) / 100;
}

const PATRON_FILA_NO_TRANSACCIONAL = /^saldo\s+(inicial|final|anterior)\b/i;

/**
 * Filtra filas que la IA a veces incluye por error como "movimiento" pero en
 * realidad repiten el saldo (ej. "Saldo Inicial"/"Saldo Final" impreso como
 * encabezado o pie de la tabla del banco) — esa info ya se captura aparte en
 * saldoInicialDeclarado/saldoFinalDeclarado. Si se dejan pasar, signedDelta()
 * las suma como si fueran un movimiento real y duplica el saldo calculado en
 * cascada para el resto del extracto.
 */
export function filtrarFilasNoTransaccionales<T extends { concepto: string }>(
  movimientos: T[],
): T[] {
  return movimientos.filter((m) => !PATRON_FILA_NO_TRANSACCIONAL.test(m.concepto.trim()));
}

/**
 * Validación de saldo determinística — nunca delegada a la IA. Extraída como
 * funciones puras (en vez de vivir en `ExtractosIaService`) porque la usan
 * dos consumidores distintos: `ExtractosIaService.actualizarMovimientos`
 * (edición manual, síncrona) y `ExtractosIaProcessor` (el job async que
 * procesa la carga inicial) — así ninguno de los dos duplica esta lógica.
 *
 * Valida cada movimiento contra el saldo que el extracto declara para esa
 * fila: `saldoCalculado = saldoAnterior +/- movimiento`, comparado contra
 * `saldoDeclarado`. Cuando el saldo declarado de la fila está disponible, se
 * usa como ancla para la fila siguiente (en vez de encadenar el saldo
 * puramente calculado) — así un único error de transcripción no arrastra
 * diferencias en cascada al resto del extracto.
 */
export function construirMovimientosConValidacion(
  movimientos: MovimientoValidable[],
  saldoInicialDeclarado: number | undefined,
): MovimientoExtracto[] {
  let saldoAncla = saldoInicialDeclarado;

  return movimientos.map((mov) => {
    if (saldoAncla === undefined) {
      return {
        fecha: mov.fecha,
        concepto: mov.concepto,
        monto: mov.monto,
        tipo: mov.tipo,
        numeroComprobante: mov.numeroComprobante,
        saldoDeclarado: mov.saldoDeclarado,
        validacionSaldo: ValidacionSaldo.NO_APLICA,
      };
    }

    // Bug real reportado por el usuario: la IA a veces lee la columna
    // Débito/Crédito al revés (transcribe un crédito como débito, o
    // viceversa) mientras el monto en sí está bien. Cuando el banco imprime
    // el saldo corrido de ESTA fila (`saldoDeclarado`), ese dato es
    // ground-truth — si invertir "tipo" hace que el saldo calculado
    // coincida (la diferencia contra el original es exactamente el doble
    // del monto, porque invertir el signo de un delta lo mueve 2x), es
    // prácticamente seguro que se trata de este bug específico y no de un
    // monto mal transcripto. Se corrige solo acá en vez de dejarlo como
    // "Diferencia" para que el contador tenga que arreglarlo a mano — la
    // validación de saldo ya es la autoridad determinística por sobre lo
    // que dijo la IA (ver el comentario de `construirMovimientosConValidacion`
    // más arriba), esto es una extensión directa de esa misma idea.
    let tipo = mov.tipo;
    let saldoCalculado = redondear(saldoAncla + signedDelta({ ...mov, tipo }));

    if (mov.saldoDeclarado !== undefined && tipo !== undefined) {
      const diferenciaOriginal = redondear(mov.saldoDeclarado - saldoCalculado);
      const yaOk = Math.abs(diferenciaOriginal) <= TOLERANCIA_SALDO;
      const pareceTipoInvertido =
        !yaOk &&
        Math.abs(Math.abs(diferenciaOriginal) - 2 * Math.abs(mov.monto)) <= TOLERANCIA_SALDO;

      if (pareceTipoInvertido) {
        tipo = tipoOpuesto(tipo);
        saldoCalculado = redondear(saldoAncla + signedDelta({ ...mov, tipo }));
      }
    }

    const base = {
      fecha: mov.fecha,
      concepto: mov.concepto,
      monto: mov.monto,
      tipo,
      numeroComprobante: mov.numeroComprobante,
      saldoDeclarado: mov.saldoDeclarado,
    };

    if (mov.saldoDeclarado === undefined) {
      saldoAncla = saldoCalculado;
      return {
        ...base,
        saldoCalculado,
        validacionSaldo: ValidacionSaldo.NO_APLICA,
      };
    }

    const diferenciaSaldo = redondear(mov.saldoDeclarado - saldoCalculado);
    const validacionSaldo =
      Math.abs(diferenciaSaldo) <= TOLERANCIA_SALDO
        ? ValidacionSaldo.OK
        : ValidacionSaldo.DIFERENCIA;

    saldoAncla = mov.saldoDeclarado;

    return { ...base, saldoCalculado, diferenciaSaldo, validacionSaldo };
  });
}

export function contarDiferencias(movimientos: MovimientoExtracto[]): number {
  return movimientos.filter((m) => m.validacionSaldo === ValidacionSaldo.DIFERENCIA).length;
}

export function describirDiferencias(movimientos: MovimientoExtracto[]): string {
  return movimientos
    .filter((m) => m.validacionSaldo === ValidacionSaldo.DIFERENCIA)
    .map(
      (m) =>
        `- Fecha ${m.fecha}, "${m.concepto}": saldo declarado ${m.saldoDeclarado}, saldo esperado ${m.saldoCalculado} (diferencia ${m.diferenciaSaldo}).`,
    )
    .join('\n');
}

export function determinarEstadoFinal(
  movimientos: MovimientoExtracto[],
  saldoFinalDeclarado: number | undefined,
): EstadoExtracto {
  if (contarDiferencias(movimientos) > 0) {
    return EstadoExtracto.REQUIERE_REVISION;
  }

  const saldoFinalCalculado = [...movimientos]
    .reverse()
    .find((m) => m.saldoCalculado !== undefined)?.saldoCalculado;

  if (saldoFinalDeclarado !== undefined && saldoFinalCalculado !== undefined) {
    const diferenciaFinal = redondear(saldoFinalDeclarado - saldoFinalCalculado);
    if (Math.abs(diferenciaFinal) > TOLERANCIA_SALDO) {
      return EstadoExtracto.REQUIERE_REVISION;
    }
  }

  return EstadoExtracto.PROCESADO;
}
