import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ReglaClasificacion,
  ReglaClasificacionSchema,
} from '../reglas-clasificacion/schemas/regla-clasificacion.schema';
import {
  CuentaContable,
  CuentaContableSchema,
} from '../plan-cuentas/schemas/cuenta-contable.schema';
import { CuentasBancariasModule } from '../cuentas-bancarias/cuentas-bancarias.module';
import { AsientoContableService } from './asiento-contable.service';

/**
 * Fuente autoritativa del armado de asientos contables a partir de un
 * extracto ya procesado — consumida por `CatedralModule` para la
 * exportación. Inyecta los modelos de `ReglaClasificacion`/`CuentaContable`
 * directo (en vez de reusar `ReglasClasificacionService.findAll`/
 * `PlanCuentasService.findAll`, ambos paginados con `limit` tope 100 —
 * ver `PaginationQueryDto`) para no perder reglas/cuentas silenciosamente en
 * un cliente con más de 100 activas.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReglaClasificacion.name, schema: ReglaClasificacionSchema },
      { name: CuentaContable.name, schema: CuentaContableSchema },
    ]),
    CuentasBancariasModule,
  ],
  providers: [AsientoContableService],
  exports: [AsientoContableService],
})
export class AsientosContablesModule {}
