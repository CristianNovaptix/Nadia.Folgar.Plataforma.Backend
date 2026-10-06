import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { GastoMensual } from './schemas/gasto-mensual.schema';
import { ImporteManualMes } from './schemas/importe-manual-mes.schema';
import { Reunion } from './schemas/reunion.schema';
import {
  CreateGastoDto,
  CreateReunionDto,
  UpdateGastoDto,
  UpdateReunionDto,
  UpsertImporteManualDto,
} from './dto/inicio.dto';

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

/** "2026-01" -> "2025-12". */
export function periodoAnterior(periodo: string): string {
  const [anio, mes] = periodo.split('-').map(Number);
  const fecha = new Date(anio, mes - 2, 1);
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
}

/** Datos cargados a mano para las cards del Inicio (gastos, importes históricos, reuniones). */
@Injectable()
export class InicioService {
  constructor(
    @InjectModel(GastoMensual.name) private readonly gastoModel: Model<GastoMensual>,
    @InjectModel(ImporteManualMes.name) private readonly importeModel: Model<ImporteManualMes>,
    @InjectModel(Reunion.name) private readonly reunionModel: Model<Reunion>,
  ) {}

  findGastos(periodo: string, estudioId: Types.ObjectId) {
    return this.gastoModel.find({ estudioId, periodo }).sort({ createdAt: 1 }).exec();
  }

  createGasto(dto: CreateGastoDto, estudioId: Types.ObjectId) {
    return this.gastoModel.create({ ...dto, estudioId });
  }

  async updateGasto(id: string, dto: UpdateGastoDto, estudioId: Types.ObjectId) {
    const gasto = await this.gastoModel
      .findOneAndUpdate({ _id: id, estudioId }, dto, { new: true })
      .exec();
    if (!gasto) throw new NotFoundException('Gasto no encontrado');
    return gasto;
  }

  async deleteGasto(id: string, estudioId: Types.ObjectId) {
    const gasto = await this.gastoModel.findOneAndDelete({ _id: id, estudioId }).exec();
    if (!gasto) throw new NotFoundException('Gasto no encontrado');
  }

  /**
   * Copia al mes pedido los gastos del mes anterior — solo los conceptos que
   * todavía no estén cargados en ese mes, así correrlo dos veces no duplica.
   */
  async copiarGastosMesAnterior(periodo: string, estudioId: Types.ObjectId) {
    const [anteriores, actuales] = await Promise.all([
      this.gastoModel.find({ estudioId, periodo: periodoAnterior(periodo) }).exec(),
      this.gastoModel.find({ estudioId, periodo }).exec(),
    ]);
    const yaCargados = new Set(actuales.map((g) => g.concepto.trim().toLowerCase()));
    const nuevos = anteriores
      .filter((g) => !yaCargados.has(g.concepto.trim().toLowerCase()))
      .map((g) => ({ periodo, concepto: g.concepto, monto: g.monto, estudioId }));
    if (nuevos.length > 0) await this.gastoModel.insertMany(nuevos);
    return this.findGastos(periodo, estudioId);
  }

  findImportesManuales(estudioId: Types.ObjectId) {
    return this.importeModel.find({ estudioId }).sort({ periodo: 1 }).exec();
  }

  async upsertImporteManual(periodo: string, dto: UpsertImporteManualDto, estudioId: Types.ObjectId) {
    if (!PERIODO.test(periodo)) throw new BadRequestException('periodo debe tener formato YYYY-MM');
    return this.importeModel
      .findOneAndUpdate({ estudioId, periodo }, { $set: dto }, { new: true, upsert: true })
      .exec();
  }

  findReuniones(desde: Date, hasta: Date, estudioId: Types.ObjectId) {
    return this.reunionModel
      .find({ estudioId, fecha: { $gte: desde, $lte: hasta }, enPapelera: { $ne: true } })
      .sort({ fecha: 1 })
      .populate('clienteId', 'nombre')
      .exec();
  }

  /** Reuniones en la papelera del calendario, de cualquier fecha. */
  findReunionesPapelera(estudioId: Types.ObjectId) {
    return this.reunionModel
      .find({ estudioId, enPapelera: true })
      .sort({ updatedAt: -1 })
      .populate('clienteId', 'nombre')
      .exec();
  }

  async createReunion(dto: CreateReunionDto, estudioId: Types.ObjectId) {
    const reunion = await this.reunionModel.create({ ...dto, estudioId });
    return reunion.populate('clienteId', 'nombre');
  }

  async updateReunion(id: string, dto: UpdateReunionDto, estudioId: Types.ObjectId) {
    const { clienteId, ...resto } = dto;
    const update =
      clienteId === null
        ? { $set: resto, $unset: { clienteId: 1 } }
        : { $set: { ...resto, ...(clienteId ? { clienteId } : {}) } };
    const reunion = await this.reunionModel
      .findOneAndUpdate({ _id: id, estudioId }, update, { new: true })
      .populate('clienteId', 'nombre')
      .exec();
    if (!reunion) throw new NotFoundException('Reunión no encontrada');
    return reunion;
  }

  async deleteReunion(id: string, estudioId: Types.ObjectId) {
    const reunion = await this.reunionModel.findOneAndDelete({ _id: id, estudioId }).exec();
    if (!reunion) throw new NotFoundException('Reunión no encontrada');
  }
}
