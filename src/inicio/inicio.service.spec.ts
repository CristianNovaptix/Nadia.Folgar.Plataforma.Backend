import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { InicioService, periodoAnterior } from './inicio.service';
import { GastoMensual } from './schemas/gasto-mensual.schema';
import { ImporteManualMes } from './schemas/importe-manual-mes.schema';
import { Reunion } from './schemas/reunion.schema';
import { User } from '../users/schemas/user.schema';
import { ClienteHistorialService } from '../clientes/cliente-historial.service';

describe('InicioService', () => {
  let service: InicioService;
  const estudioId = new Types.ObjectId();

  const gastoModelMock: any = { find: jest.fn(), insertMany: jest.fn() };
  const importeModelMock: any = { findOneAndUpdate: jest.fn() };
  const reunionModelMock: any = { find: jest.fn() };
  const historialMock = { registrarCambioDeOrigen: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InicioService,
        { provide: getModelToken(GastoMensual.name), useValue: gastoModelMock },
        { provide: getModelToken(ImporteManualMes.name), useValue: importeModelMock },
        { provide: getModelToken(Reunion.name), useValue: reunionModelMock },
        { provide: getModelToken(User.name), useValue: {} },
        { provide: ClienteHistorialService, useValue: historialMock },
      ],
    }).compile();
    service = moduleRef.get(InicioService);
  });

  it('deleteReunion deja registrado en el historial del cliente quién la eliminó, antes de borrarla', async () => {
    const orden: string[] = [];
    const reunion = {
      clienteId: new Types.ObjectId(),
      titulo: 'Cierre',
      deleteOne: jest.fn(() => orden.push('borrada')),
    };
    reunionModelMock.findOne = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(reunion) });
    historialMock.registrarCambioDeOrigen.mockImplementation(async () => orden.push('historial'));

    await service.deleteReunion('r1', estudioId, 'u1');

    expect(historialMock.registrarCambioDeOrigen).toHaveBeenCalledWith(
      reunion.clienteId,
      estudioId,
      'registro_eliminado',
      'Se eliminó definitivamente la reunión "Cierre"',
      'u1',
    );
    expect(orden).toEqual(['historial', 'borrada']);
  });

  it('findReuniones solo trae las propias, las que lo tienen como miembro y las viejas sin creador', async () => {
    const userId = new Types.ObjectId();
    const query: any = { sort: jest.fn(), populate: jest.fn(), exec: jest.fn().mockResolvedValue([]) };
    query.sort.mockReturnValue(query);
    query.populate.mockReturnValue(query);
    reunionModelMock.find.mockReturnValue(query);

    await service.findReuniones(new Date('2026-10-01'), new Date('2026-10-31'), estudioId, userId);

    expect(reunionModelMock.find.mock.calls[0][0].$or).toEqual([
      { creadoPor: { $exists: false } },
      { creadoPor: userId },
      { miembros: userId },
    ]);
  });

  it('periodoAnterior cruza el año', () => {
    expect(periodoAnterior('2026-01')).toBe('2025-12');
    expect(periodoAnterior('2026-10')).toBe('2026-09');
  });

  it('copia los gastos del mes anterior sin duplicar conceptos ya cargados', async () => {
    const anteriores = [
      { concepto: 'Alquiler', monto: 100 },
      { concepto: 'Internet', monto: 20 },
    ];
    const actuales = [{ concepto: 'alquiler ', monto: 120 }];
    gastoModelMock.find
      .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(anteriores) })
      .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(actuales) })
      .mockReturnValueOnce({ sort: () => ({ exec: jest.fn().mockResolvedValue([]) }) });

    await service.copiarGastosMesAnterior('2026-10', estudioId);

    expect(gastoModelMock.find).toHaveBeenNthCalledWith(1, { estudioId, periodo: '2026-09' });
    expect(gastoModelMock.insertMany).toHaveBeenCalledWith([
      { periodo: '2026-10', concepto: 'Internet', monto: 20, estudioId },
    ]);
  });

  it('rechaza un importe manual con período inválido', async () => {
    await expect(service.upsertImporteManual('2026-13', { facturado: 1 }, estudioId)).rejects.toThrow(
      BadRequestException,
    );
    expect(importeModelMock.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
