import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClientesModule } from '../clientes/clientes.module';
import { Cliente, ClienteSchema } from '../clientes/schemas/cliente.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { AbonoCambio, AbonoCambioSchema } from './schemas/abono-cambio.schema';
import { DeudaHonorario, DeudaHonorarioSchema } from './schemas/deuda-honorario.schema';
import { HonorarioConfig, HonorarioConfigSchema } from './schemas/honorario-config.schema';
import { FinanzasService } from './finanzas.service';
import { FinanzasController } from './finanzas.controller';

/**
 * Finanzas: abono mensual de cada cliente, deuda que se genera sola el día 1,
 * pagos totales o parciales y métricas. La emisión de la factura fiscal en
 * ARCA queda para más adelante (pedido explícito del usuario): acá solo se
 * guarda quién factura y qué día, sin emitir nada.
 */
@Module({
  imports: [
    ClientesModule,
    MongooseModule.forFeature([
      { name: HonorarioConfig.name, schema: HonorarioConfigSchema },
      { name: AbonoCambio.name, schema: AbonoCambioSchema },
      { name: DeudaHonorario.name, schema: DeudaHonorarioSchema },
      { name: Cliente.name, schema: ClienteSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [FinanzasController],
  providers: [FinanzasService],
})
export class FinanzasModule {}
