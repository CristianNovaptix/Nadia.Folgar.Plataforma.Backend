import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CuentasBancariasService } from '../cuentas-bancarias/cuentas-bancarias.service';
import {
  ReglaClasificacion,
  ReglaClasificacionDocument,
} from '../reglas-clasificacion/schemas/regla-clasificacion.schema';
import {
  CuentaContable,
  CuentaContableDocument,
} from '../plan-cuentas/schemas/cuenta-contable.schema';
import { ExtractoBancarioDocument } from '../extractos-ia/schemas/extracto-bancario.schema';
import { AsignacionManualDto } from './dto/asignacion-manual.dto';
import {
  AsientoMensual,
  AsignacionManual,
  LadoAsientoLogic,
  MovimientoParaClasificar,
  ReglaParaClasificar,
  construirAsientosMensuales,
} from './asiento-contable.logic';

const TOLERANCIA_BALANCE = 0.01;

export interface LineaAsientoResuelta {
  cuentaContableId: string;
  codigo: string;
  nombre: string;
  lado: LadoAsientoLogic;
  monto: number;
}

export interface MovimientoSinClasificar {
  movimientoId: string;
  concepto: string;
  monto: number;
}

export interface AsientoMensualResuelto {
  /** "YYYY-MM", o "SIN_FECHA" si hubo movimientos con fecha no parseable. */
  periodo: string;
  lineas: LineaAsientoResuelta[];
  totalDebe: number;
  totalHaber: number;
  /** `false` también cuando falta el saldo de cierre del mes — no hay plug posible, no se puede validar. */
  cuadra: boolean;
  sinClasificar: MovimientoSinClasificar[];
}

export interface AsientoContableResultado {
  /** Un elemento por cada mes calendario que el extracto contiene — ver `construirAsientosMensuales`. */
  meses: AsientoMensualResuelto[];
  /** Nombre del banco de la cuenta bancaria del extracto — para el nombre/descripción del export. */
  banco: string;
}

function redondear(valor: number): number {
  return Math.round(valor * 100) / 100;
}

/**
 * Arma el asiento contable de un extracto — fuente autoritativa (no la
 * vista previa client-side de `ResumenAsientoContable.tsx`, que existe solo
 * para que el contador vea el resultado en vivo mientras edita). Usada por
 * `CatedralFileAdapter.exportarAsientoContable` como paso previo,
 * obligatorio, a generar el archivo que se importa en Catedral.
 *
 * Un extracto que abarca más de un mes calendario arma UN ASIENTO POR MES
 * (ver `construirAsientosMensuales`), cada uno con su propio saldo
 * inicial/final y su propia validación de balance — no un único asiento
 * combinado para todo el rango.
 */
@Injectable()
export class AsientoContableService {
  constructor(
    @InjectModel(ReglaClasificacion.name)
    private readonly reglaModel: Model<ReglaClasificacionDocument>,
    @InjectModel(CuentaContable.name)
    private readonly cuentaContableModel: Model<CuentaContableDocument>,
    private readonly cuentasBancariasService: CuentasBancariasService,
  ) {}

  async construirAsiento(
    extracto: ExtractoBancarioDocument,
    estudioId: Types.ObjectId,
    asignacionesManuales: AsignacionManualDto[] = [],
  ): Promise<AsientoContableResultado> {
    const cuentaBancaria = await this.cuentasBancariasService.findOne(
      extracto.cuentaBancariaId.toString(),
      estudioId,
    );
    const cuentaContableBancariaId = cuentaBancaria.cuentaContableId.toString();

    const cuentasContables = await this.cuentaContableModel.find({ estudioId }).exec();
    const cuentaContableIds = new Set(cuentasContables.map((c) => c._id.toString()));

    for (const asignacion of asignacionesManuales) {
      if (!cuentaContableIds.has(asignacion.cuentaContableId)) {
        throw new BadRequestException(
          `La cuenta contable ${asignacion.cuentaContableId} no pertenece al plan de cuentas del cliente`,
        );
      }
    }

    const reglasDocs = await this.reglaModel
      .find({ clienteId: extracto.clienteId, estudioId, activa: true })
      .exec();
    const reglas: ReglaParaClasificar[] = reglasDocs.map((r) => ({
      _id: r._id.toString(),
      cuentaBancariaId: r.cuentaBancariaId?.toString(),
      patronTexto: r.patronTexto,
      condicionMonto: r.condicionMonto
        ? {
            operador: r.condicionMonto.operador,
            valor: r.condicionMonto.valor,
            valorMin: r.condicionMonto.valorMin,
            valorMax: r.condicionMonto.valorMax,
          }
        : undefined,
      tipoMovimiento: r.tipoMovimiento,
      cuentaContableId: r.cuentaContableId.toString(),
      ladoAsiento: r.ladoAsiento,
      prioridad: r.prioridad,
      activa: r.activa,
      cuentaContableSecundariaId: r.cuentaContableSecundariaId?.toString(),
      porcentajeSecundario: r.porcentajeSecundario,
    }));

    const movimientos: MovimientoParaClasificar[] = extracto.movimientos.map((m) => ({
      _id: m._id!.toString(),
      concepto: m.concepto,
      monto: m.monto,
      tipo: m.tipo,
      fecha: m.fecha,
      saldoCalculado: m.saldoCalculado,
    }));

    const asignacionesMap = new Map<string, AsignacionManual>(
      asignacionesManuales.map((a) => [
        a.movimientoId,
        { cuentaContableId: a.cuentaContableId, ladoAsiento: a.ladoAsiento },
      ]),
    );

    const asientosMensuales = construirAsientosMensuales(
      movimientos,
      reglas,
      extracto.cuentaBancariaId.toString(),
      cuentaContableBancariaId,
      extracto.saldoInicialDeclarado,
      asignacionesMap,
    );

    const cuentaContableById = new Map(cuentasContables.map((c) => [c._id.toString(), c]));
    const meses: AsientoMensualResuelto[] = asientosMensuales.map((mes: AsientoMensual) => {
      const lineasResueltas: LineaAsientoResuelta[] = mes.lineas.map((linea) => {
        const cuenta = cuentaContableById.get(linea.cuentaContableId);
        return {
          cuentaContableId: linea.cuentaContableId,
          codigo: cuenta?.codigo ?? linea.cuentaContableId,
          nombre: cuenta?.nombre ?? '',
          lado: linea.lado,
          monto: linea.monto,
        };
      });

      const totalDebe = redondear(
        lineasResueltas.filter((l) => l.lado === 'debe').reduce((acc, l) => acc + l.monto, 0),
      );
      const totalHaber = redondear(
        lineasResueltas.filter((l) => l.lado === 'haber').reduce((acc, l) => acc + l.monto, 0),
      );
      const plugDisponible = mes.saldoInicial !== undefined && mes.saldoFinal !== undefined;
      const cuadra = plugDisponible && Math.abs(totalDebe - totalHaber) <= TOLERANCIA_BALANCE;

      const sinClasificar: MovimientoSinClasificar[] = mes.clasificados
        .filter((c) => c.cuentaContableId === null)
        .map((c) => ({
          movimientoId: c.movimiento._id,
          concepto: c.movimiento.concepto,
          monto: c.movimiento.monto,
        }));

      return {
        periodo: mes.periodo,
        lineas: lineasResueltas,
        totalDebe,
        totalHaber,
        cuadra,
        sinClasificar,
      };
    });

    return { meses, banco: cuentaBancaria.banco };
  }
}
