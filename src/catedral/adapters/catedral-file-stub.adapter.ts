import { Injectable, Logger } from '@nestjs/common';
import {
  AsientoContableExportInput,
  AsientoContableExportResult,
  CatedralSyncPort,
  SyncResult,
} from '../ports/catedral-sync.port';

/**
 * ============================================================================
 *  PLACEHOLDER — NO ES UNA INTEGRACIÓN REAL CONTRA CATEDRAL
 * ============================================================================
 * Este adapter existe únicamente para que `CatedralService`, el controller y
 * el log de auditoría (`CatedralSyncLog`) se puedan desarrollar y testear
 * hoy, sin bloquearse en una decisión que todavía no se tomó.
 *
 * FOLGAR-029 ("Definir alcance final de integración: API o exportación") aún
 * no está resuelto con el cliente — no sabemos si la vía final va a ser API,
 * exportación/importación de archivos, u otra. Por eso este adapter NO se
 * conecta a ningún host, no lee ni escribe ningún archivo con formato de
 * Catedral, y no usa credenciales reales: solo loguea la operación solicitada
 * y devuelve un resultado simulado.
 *
 * Cuando FOLGAR-029 se resuelva, reemplazar el `useClass` del provider
 * `CATEDRAL_SYNC_PORT` en `catedral.module.ts` por un adapter concreto
 * (p. ej. `CatedralApiAdapter` o `CatedralFileAdapter`) que implemente este
 * mismo puerto `CatedralSyncPort`. `CatedralService` y `CatedralController`
 * no deberían requerir cambios.
 * ============================================================================
 */
@Injectable()
export class CatedralFileStubAdapter implements CatedralSyncPort {
  private readonly logger = new Logger(CatedralFileStubAdapter.name);

  exportarClientes(): Promise<SyncResult> {
    this.logger.warn(
      '[STUB] exportarClientes() invocado — todavía no hay integración real con Catedral (pendiente FOLGAR-029)',
    );

    return Promise.resolve({
      exitoso: true,
      mensaje:
        'Simulado: exportación de clientes no implementada aún (pendiente de definir vía de integración - FOLGAR-029)',
    });
  }

  importarMovimientos(origen: unknown): Promise<SyncResult> {
    this.logger.warn(
      `[STUB] importarMovimientos() invocado con origen=${JSON.stringify(origen)} — todavía no hay integración real con Catedral (pendiente FOLGAR-029)`,
    );

    return Promise.resolve({
      exitoso: true,
      mensaje:
        'Simulado: importación de movimientos no implementada aún (pendiente de definir vía de integración - FOLGAR-029)',
    });
  }

  exportarAsientoContable(input: AsientoContableExportInput): Promise<AsientoContableExportResult> {
    this.logger.warn(
      `[STUB] exportarAsientoContable() invocado para extracto=${input.extractoId} — usar CatedralFileAdapter para la exportación real`,
    );

    return Promise.resolve({
      exitoso: true,
      mensaje:
        'Simulado: exportación de asiento contable no implementada en este adapter (usar CatedralFileAdapter)',
    });
  }
}
