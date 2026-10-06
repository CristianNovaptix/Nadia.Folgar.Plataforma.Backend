import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RegimenFiscalConfig, RegimenFiscalConfigSchema } from './schemas/regimen-fiscal-config.schema';
import { RegimenesFiscalesService } from './regimenes-fiscales.service';
import { RegimenesFiscalesController } from './regimenes-fiscales.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: RegimenFiscalConfig.name, schema: RegimenFiscalConfigSchema }])],
  controllers: [RegimenesFiscalesController],
  providers: [RegimenesFiscalesService],
})
export class RegimenesFiscalesModule {}
