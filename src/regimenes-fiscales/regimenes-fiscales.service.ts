import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { RegimenFiscal } from '../clientes/schemas/cliente.schema';
import { RegimenFiscalConfig, RegimenFiscalConfigDocument } from './schemas/regimen-fiscal-config.schema';
import { UpdateRegimenFiscalDto } from './dto/update-regimen-fiscal.dto';

@Injectable()
export class RegimenesFiscalesService {
  constructor(
    @InjectModel(RegimenFiscalConfig.name)
    private readonly configModel: Model<RegimenFiscalConfigDocument>,
  ) {}

  /** Siempre devuelve los regímenes existentes, aunque todavía no tengan nada cargado. */
  async findAll(estudioId: Types.ObjectId) {
    const configs = await this.configModel.find({ estudioId }).exec();
    return Object.values(RegimenFiscal).map((regimen) => ({
      regimen,
      obligaciones: configs.find((c) => c.regimen === regimen)?.obligaciones ?? [],
    }));
  }

  async update(regimen: string, dto: UpdateRegimenFiscalDto, estudioId: Types.ObjectId) {
    if (!Object.values(RegimenFiscal).includes(regimen as RegimenFiscal)) {
      throw new BadRequestException('Régimen fiscal inexistente');
    }
    const obligaciones = dto.obligaciones.map((o) => ({ nombre: o.nombre.trim(), jurisdiccion: o.jurisdiccion }));
    const config = await this.configModel
      .findOneAndUpdate({ estudioId, regimen }, { $set: { obligaciones } }, { new: true, upsert: true })
      .exec();
    return { regimen, obligaciones: config.obligaciones };
  }
}
