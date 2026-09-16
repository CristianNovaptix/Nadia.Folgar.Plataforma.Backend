import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import {
  LadoAsiento,
  PRIORIDAD_SUGERIDA_IA,
  ProcedenciaRegla,
  ReglaClasificacion,
  ReglaClasificacionDocument,
} from './schemas/regla-clasificacion.schema';
import { CreateReglaClasificacionDto } from './dto/create-regla-clasificacion.dto';
import { UpdateReglaClasificacionDto } from './dto/update-regla-clasificacion.dto';
import { QueryReglaClasificacionDto } from './dto/query-regla-clasificacion.dto';
import { PaginatedResult } from '../common/dto/pagination-query.dto';
import { ClientesService } from '../clientes/clientes.service';
import { PlanCuentasService } from '../plan-cuentas/plan-cuentas.service';
import { CuentasBancariasService } from '../cuentas-bancarias/cuentas-bancarias.service';

@Injectable()
export class ReglasClasificacionService {
  constructor(
    @InjectModel(ReglaClasificacion.name)
    private readonly reglaModel: Model<ReglaClasificacionDocument>,
    private readonly clientesService: ClientesService,
    private readonly planCuentasService: PlanCuentasService,
    private readonly cuentasBancariasService: CuentasBancariasService,
  ) {}

  async findAll(
    query: QueryReglaClasificacionDto,
    estudioId: Types.ObjectId,
  ): Promise<PaginatedResult<ReglaClasificacionDocument>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const filter: FilterQuery<ReglaClasificacionDocument> = { estudioId };
    if (query.clienteId) {
      filter.clienteId = new Types.ObjectId(query.clienteId);
    }
    if (query.cuentaBancariaId) {
      filter.cuentaBancariaId = new Types.ObjectId(query.cuentaBancariaId);
    }
    if (query.procedencia) {
      filter.procedencia = query.procedencia;
    }
    if (query.activa !== undefined) {
      filter.activa = query.activa;
    }
    if (query.search) {
      filter.$or = [
        { conceptoContable: { $regex: query.search, $options: 'i' } },
        { patronTexto: { $regex: query.search, $options: 'i' } },
      ];
    }

    const sort: Record<string, 1 | -1> = query.sortBy
      ? { [query.sortBy]: query.sortDir === 'desc' ? -1 : 1 }
      : { prioridad: 1 };

    const [data, total] = await Promise.all([
      this.reglaModel
        .find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.reglaModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: string, estudioId: Types.ObjectId): Promise<ReglaClasificacionDocument> {
    const regla = await this.reglaModel.findOne({ _id: id, estudioId }).exec();
    if (!regla) {
      throw new NotFoundException('Regla de clasificación no encontrada');
    }
    return regla;
  }

  /**
   * Valida que `cuentaContableId` exista (ya no está scopeado por cliente —
   * ver `CuentaContable`) y que, si viene, `cuentaBancariaId` pertenezca al
   * mismo cliente.
   */
  private async assertReferenciasConsistentes(
    clienteId: string,
    cuentaContableId: string,
    cuentaBancariaId: string | undefined,
    estudioId: Types.ObjectId,
    cuentaContableSecundariaId?: string,
  ): Promise<void> {
    await this.planCuentasService.findOne(cuentaContableId, estudioId);

    if (cuentaContableSecundariaId) {
      await this.planCuentasService.findOne(cuentaContableSecundariaId, estudioId);
    }

    if (cuentaBancariaId) {
      const cuentaBancaria = await this.cuentasBancariasService.findOne(
        cuentaBancariaId,
        estudioId,
      );
      if (cuentaBancaria.clienteId.toString() !== clienteId) {
        throw new BadRequestException('La cuenta bancaria debe pertenecer al mismo cliente');
      }
    }
  }

  async create(
    dto: CreateReglaClasificacionDto,
    estudioId: Types.ObjectId,
    creadoPor: Types.ObjectId,
  ): Promise<ReglaClasificacionDocument> {
    await this.clientesService.findOne(dto.clienteId, estudioId);
    await this.assertReferenciasConsistentes(
      dto.clienteId,
      dto.cuentaContableId,
      dto.cuentaBancariaId,
      estudioId,
      dto.cuentaContableSecundariaId,
    );

    const procedencia = dto.origenMovimientoId
      ? ProcedenciaRegla.APRENDIDA
      : ProcedenciaRegla.MANUAL;

    return this.reglaModel.create({ ...dto, procedencia, creadoPor, estudioId });
  }

  /**
   * Crea una regla inferida por `ExtractosIaProcessor` al procesar un
   * extracto — a diferencia de `create()`, no pasa por
   * `CreateReglaClasificacionDto` (no es un endpoint HTTP, nadie externo la
   * llama) ni revalida que la cuenta contable pertenezca al cliente: quien
   * llama ya la sacó de una consulta scopeada a ese mismo cliente
   * (`PlanCuentasService.findAll`), así que la consistencia ya está
   * garantizada por construcción. Prioridad alta y `procedencia: IA` para que
   * nunca le gane a una regla manual/aprendida para el mismo movimiento, y
   * quede auditable/desactivable como cualquier otra en la pantalla de
   * Reglas de clasificación.
   */
  async crearSugeridaPorIa(
    input: {
      clienteId: string;
      cuentaBancariaId?: string;
      conceptoContable: string;
      cuentaContableId: string;
      ladoAsiento: LadoAsiento;
      patronTexto: string;
      tipoMovimiento?: 'debito' | 'credito';
    },
    estudioId: Types.ObjectId,
    creadoPor: Types.ObjectId,
  ): Promise<ReglaClasificacionDocument> {
    return this.reglaModel.create({
      ...input,
      prioridad: PRIORIDAD_SUGERIDA_IA,
      procedencia: ProcedenciaRegla.IA,
      activa: true,
      creadoPor,
      estudioId,
    });
  }

  async update(
    id: string,
    dto: UpdateReglaClasificacionDto,
    estudioId: Types.ObjectId,
  ): Promise<ReglaClasificacionDocument> {
    const regla = await this.findOne(id, estudioId);

    const nextClienteId = dto.clienteId ?? regla.clienteId.toString();
    if (dto.clienteId) {
      await this.clientesService.findOne(dto.clienteId, estudioId);
    }
    if (
      dto.cuentaContableId ||
      dto.cuentaBancariaId ||
      dto.clienteId ||
      dto.cuentaContableSecundariaId
    ) {
      await this.assertReferenciasConsistentes(
        nextClienteId,
        dto.cuentaContableId ?? regla.cuentaContableId.toString(),
        dto.cuentaBancariaId ?? regla.cuentaBancariaId?.toString(),
        estudioId,
        dto.cuentaContableSecundariaId ?? regla.cuentaContableSecundariaId?.toString(),
      );
    }

    Object.assign(regla, dto);
    await regla.save();
    return regla;
  }
}
