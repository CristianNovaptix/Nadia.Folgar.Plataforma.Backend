import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Cliente, ClienteDocument } from '../clientes/schemas/cliente.schema';
import { PanelClienteMes, PanelClienteMesDocument } from './schemas/panel-cliente-mes.schema';
import { GuardarPanelClienteDto } from './dto/panel-cliente.dto';

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Carga mensual del estudio para el Inicio del portal de un cliente. */
@Injectable()
export class PanelClienteService {
  constructor(
    @InjectModel(PanelClienteMes.name)
    private readonly panelModel: Model<PanelClienteMesDocument>,
    @InjectModel(Cliente.name) private readonly clienteModel: Model<ClienteDocument>,
  ) {}

  async listar(clienteId: string, estudioId: Types.ObjectId): Promise<PanelClienteMesDocument[]> {
    const cliente = await this.validarCliente(clienteId, estudioId);
    return this.panelModel.find({ clienteId: cliente, estudioId }).sort({ periodo: 1 }).exec();
  }

  async guardar(
    clienteId: string,
    periodo: string,
    dto: GuardarPanelClienteDto,
    estudioId: Types.ObjectId,
  ): Promise<PanelClienteMesDocument> {
    if (!PERIODO.test(periodo)) throw new BadRequestException('Período inválido (AAAA-MM)');
    const cliente = await this.validarCliente(clienteId, estudioId);
    const set: Partial<PanelClienteMes> = {
      empleados: dto.empleados,
      cargasSociales: dto.cargasSociales,
      impuestos: dto.impuestos,
    };
    const unset: Record<string, 1> = {};
    for (const campo of ['facturacion', 'gastos'] as const) {
      const valor = dto[campo];
      if (typeof valor === 'number') set[campo] = valor;
      else unset[campo] = 1;
    }
    return (await this.panelModel
      .findOneAndUpdate(
        { clienteId: cliente, estudioId, periodo },
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .exec())!;
  }

  private async validarCliente(clienteId: string, estudioId: Types.ObjectId): Promise<Types.ObjectId> {
    if (!Types.ObjectId.isValid(clienteId)) throw new NotFoundException('Cliente no encontrado');
    const id = new Types.ObjectId(clienteId);
    const existe = await this.clienteModel.exists({ _id: id, estudioId }).exec();
    if (!existe) throw new NotFoundException('Cliente no encontrado');
    return id;
  }
}
