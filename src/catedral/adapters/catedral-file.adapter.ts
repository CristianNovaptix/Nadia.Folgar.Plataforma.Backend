import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  AsientoContableExportInput,
  AsientoContableExportResult,
  CatedralSyncPort,
  SyncResult,
} from '../ports/catedral-sync.port';
import { ExtractosIaService } from '../../extractos-ia/extractos-ia.service';
import { AsientoContableService } from '../../asientos-contables/asiento-contable.service';
import { generarPlanillaAsientoCatedral } from '../asiento-catedral-excel.builder';

const CONTENT_TYPE_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Adapter real de `CatedralSyncPort` para la vía de integración por archivo
 * (confirmada por el instructivo interno "Importar asientos... a Catedral":
 * Catedral genera una planilla, se completa y se re-importa — no una API).
 * `exportarClientes`/`importarMovimientos` se mantienen simulados, igual que
 * en `CatedralFileStubAdapter` — todavía no hay vía definida para esas dos
 * operaciones; solo `exportarAsientoContable` es real.
 */
@Injectable()
export class CatedralFileAdapter implements CatedralSyncPort {
  private readonly logger = new Logger(CatedralFileAdapter.name);

  constructor(
    private readonly extractosIaService: ExtractosIaService,
    private readonly asientoContableService: AsientoContableService,
  ) {}

  exportarClientes(): Promise<SyncResult> {
    this.logger.warn(
      '[SIN IMPLEMENTAR] exportarClientes() — todavía no hay vía definida para esta operación',
    );
    return Promise.resolve({
      exitoso: true,
      mensaje: 'Simulado: exportación de clientes no implementada aún',
    });
  }

  importarMovimientos(origen: unknown): Promise<SyncResult> {
    this.logger.warn(
      `[SIN IMPLEMENTAR] importarMovimientos() invocado con origen=${JSON.stringify(origen)} — todavía no hay vía definida para esta operación`,
    );
    return Promise.resolve({
      exitoso: true,
      mensaje: 'Simulado: importación de movimientos no implementada aún',
    });
  }

  async exportarAsientoContable(
    input: AsientoContableExportInput,
  ): Promise<AsientoContableExportResult> {
    const estudioId = new Types.ObjectId(input.estudioId);
    const extracto = await this.extractosIaService.obtenerDocumentoCompleto(
      input.extractoId,
      estudioId,
    );

    const resultado = await this.asientoContableService.construirAsiento(
      extracto,
      estudioId,
      input.asignacionesManuales,
    );

    const algunMesInvalido = resultado.meses.some((m) => !m.cuadra || m.sinClasificar.length > 0);
    if (algunMesInvalido) {
      const mesesConProblema = resultado.meses.filter(
        (m) => !m.cuadra || m.sinClasificar.length > 0,
      );
      const detalle = mesesConProblema
        .map((m) =>
          !m.cuadra
            ? `${m.periodo}: no cuadra (Debe ≠ Haber)`
            : `${m.periodo}: ${m.sinClasificar.length} movimiento(s) sin clasificar`,
        )
        .join(' | ');

      return {
        exitoso: false,
        mensaje: `El asiento tiene meses sin validar — resolvé antes de exportar: ${detalle}`,
        validacion: {
          meses: resultado.meses.map((m) => ({
            periodo: m.periodo,
            cuadra: m.cuadra,
            sinClasificar: m.sinClasificar,
          })),
        },
      };
    }

    const buffer = await generarPlanillaAsientoCatedral({
      banco: resultado.banco,
      meses: resultado.meses.map((m) => ({ periodo: m.periodo, lineas: m.lineas })),
    });

    const periodos = resultado.meses.map((m) => m.periodo).join('_');
    const nombreArchivo = `Asiento ${resultado.banco} ${periodos}.xlsx`;
    const totalLineas = resultado.meses.reduce((acc, m) => acc + m.lineas.length, 0);

    return {
      exitoso: true,
      mensaje: `Asiento exportado: ${resultado.meses.length} mes(es), ${totalLineas} líneas en total.`,
      archivo: {
        nombreArchivo,
        contentType: CONTENT_TYPE_XLSX,
        contenidoBase64: buffer.toString('base64'),
      },
    };
  }
}
