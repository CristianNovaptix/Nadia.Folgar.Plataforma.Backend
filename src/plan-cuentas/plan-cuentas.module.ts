import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CuentaContable, CuentaContableSchema } from './schemas/cuenta-contable.schema';
import { PlanCuentasService } from './plan-cuentas.service';
import { PlanCuentasController } from './plan-cuentas.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CuentaContable.name, schema: CuentaContableSchema }]),
  ],
  controllers: [PlanCuentasController],
  providers: [PlanCuentasService],
  exports: [PlanCuentasService],
})
export class PlanCuentasModule {}
