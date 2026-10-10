import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GastoMensual, GastoMensualSchema } from './schemas/gasto-mensual.schema';
import { ImporteManualMes, ImporteManualMesSchema } from './schemas/importe-manual-mes.schema';
import { Reunion, ReunionSchema } from './schemas/reunion.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { ClientesModule } from '../clientes/clientes.module';
import { InicioService } from './inicio.service';
import { InicioController } from './inicio.controller';

@Module({
  imports: [
    ClientesModule,
    MongooseModule.forFeature([
      { name: GastoMensual.name, schema: GastoMensualSchema },
      { name: ImporteManualMes.name, schema: ImporteManualMesSchema },
      { name: Reunion.name, schema: ReunionSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [InicioController],
  providers: [InicioService],
})
export class InicioModule {}
