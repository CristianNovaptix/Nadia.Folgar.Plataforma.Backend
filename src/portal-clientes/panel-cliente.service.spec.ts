import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { PanelClienteService } from './panel-cliente.service';
import { PanelClienteMes } from './schemas/panel-cliente-mes.schema';
import { Cliente } from '../clientes/schemas/cliente.schema';

const exec = <T>(valor: T) => ({ exec: jest.fn().mockResolvedValue(valor) });

describe('PanelClienteService', () => {
  const estudioId = new Types.ObjectId();
  const clienteId = new Types.ObjectId();
  let panelModel: Record<string, jest.Mock>;
  let clienteModel: Record<string, jest.Mock>;
  let service: PanelClienteService;

  beforeEach(async () => {
    panelModel = { findOneAndUpdate: jest.fn(() => exec({ periodo: '2026-11' })) };
    clienteModel = { exists: jest.fn(() => exec({ _id: clienteId })) };
    const modulo = await Test.createTestingModule({
      providers: [
        PanelClienteService,
        { provide: getModelToken(PanelClienteMes.name), useValue: panelModel },
        { provide: getModelToken(Cliente.name), useValue: clienteModel },
      ],
    }).compile();
    service = modulo.get(PanelClienteService);
  });

  const dto = {
    facturacion: 1000,
    gastos: null,
    empleados: [{ concepto: 'Ana', importe: 500 }],
    cargasSociales: [{ concepto: 'F.931', importe: 200 }],
    impuestos: [],
  };

  it('guarda el mes y borra la facturación/gastos que vienen vacíos (vuelve a ARCA)', async () => {
    await service.guardar(clienteId.toString(), '2026-11', dto, estudioId);

    const [filtro, update] = panelModel.findOneAndUpdate.mock.calls[0];
    expect(filtro).toEqual({ clienteId, estudioId, periodo: '2026-11' });
    expect(update.$set).toEqual({
      empleados: dto.empleados,
      cargasSociales: dto.cargasSociales,
      impuestos: [],
      facturacion: 1000,
    });
    expect(update.$unset).toEqual({ gastos: 1 });
  });

  it('rechaza un período mal escrito', async () => {
    await expect(
      service.guardar(clienteId.toString(), '2026-13', dto, estudioId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no deja cargar datos de un cliente de otro estudio', async () => {
    clienteModel.exists.mockReturnValue(exec(null));
    await expect(
      service.guardar(clienteId.toString(), '2026-11', dto, estudioId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
