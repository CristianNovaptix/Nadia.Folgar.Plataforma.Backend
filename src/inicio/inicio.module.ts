import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GastoMensual, GastoMensualSchema } from './schemas/gasto-mensual.schema';
import { ImporteManualMes, ImporteManualMesSchema } from './schemas/importe-manual-mes.schema';
import { Reunion, ReunionSchema } from './schemas/reunion.schema';
import { InicioService } from './inicio.service';
import { InicioController } from './inicio.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GastoMensual.name, schema: GastoMensualSchema },
      { name: ImporteManualMes.name, schema: ImporteManualMesSchema },
      { name: Reunion.name, schema: ReunionSchema },
    ]),
  ],
  controllers: [InicioController],
  providers: [InicioService],
})
export class InicioModule {}
