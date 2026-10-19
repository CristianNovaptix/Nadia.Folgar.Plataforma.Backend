import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { conDesempatePorId } from '../common/utils/orden-estable';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { CuentaContable, CuentaContableDocument } from './schemas/cuenta-contable.schema';
import { CreateCuentaContableDto } from './dto/create-cuenta-contable.dto';
import { UpdateCuentaContableDto } from './dto/update-cuenta-contable.dto';
import { QueryCuentaContableDto } from './dto/query-cuenta-contable.dto';
import { PaginatedResult } from '../common/dto/pagination-query.dto';

@Injectable()
export class PlanCuentasService {
  constructor(
    @InjectModel(CuentaContable.name)
    private readonly cuentaContableModel: Model<CuentaContableDocument>,
  ) {}

  async findAll(
    query: QueryCuentaContableDto,
    estudioId: Types.ObjectId,
  ): Promise<PaginatedResult<CuentaContableDocument>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const filter: FilterQuery<CuentaContableDocument> = { estudioId };
    if (query.search) {
      filter.$or = [
        { codigo: { $regex: query.search, $options: 'i' } },
        { nombre: { $regex: query.search, $options: 'i' } },
      ];
    }

    const sort: Record<string, 1 | -1> = query.sortBy
      ? { [query.sortBy]: query.sortDir === 'desc' ? -1 : 1 }
      : { codigo: 1 };

    const [data, total] = await Promise.all([
      this.cuentaContableModel
        .find(filter)
        .sort(conDesempatePorId(sort))
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.cuentaContableModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: string, estudioId: Types.ObjectId): Promise<CuentaContableDocument> {
    const cuenta = await this.cuentaContableModel.findOne({ _id: id, estudioId }).exec();
    if (!cuenta) {
      throw new NotFoundException('Cuenta contable no encontrada');
    }
    return cuenta;
  }

  private async assertCodigoDisponible(
    codigo: string,
    estudioId: Types.ObjectId,
    excludeId?: Types.ObjectId,
  ): Promise<void> {
    const filter: FilterQuery<CuentaContableDocument> = { estudioId, codigo };
    if (excludeId) {
      filter._id = { $ne: excludeId };
    }
    const existing = await this.cuentaContableModel.findOne(filter).exec();
    if (existing) {
      throw new ConflictException('Ya existe una cuenta contable con ese código en el estudio');
    }
  }

  async create(
    dto: CreateCuentaContableDto,
    estudioId: Types.ObjectId,
  ): Promise<CuentaContableDocument> {
    await this.assertCodigoDisponible(dto.codigo, estudioId);

    return this.cuentaContableModel.create({ ...dto, estudioId });
  }

  async update(
    id: string,
    dto: UpdateCuentaContableDto,
    estudioId: Types.ObjectId,
  ): Promise<CuentaContableDocument> {
    const cuenta = await this.findOne(id, estudioId);

    if (dto.codigo) {
      await this.assertCodigoDisponible(dto.codigo, estudioId, cuenta._id);
    }

    Object.assign(cuenta, dto);
    await cuenta.save();
    return cuenta;
  }
}
