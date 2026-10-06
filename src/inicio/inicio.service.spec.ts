import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { InicioService, periodoAnterior } from './inicio.service';
import { GastoMensual } from './schemas/gasto-mensual.schema';
import { ImporteManualMes } from './schemas/importe-manual-mes.schema';
import { Reunion } from './schemas/reunion.schema';

describe('InicioService', () => {
  let service: InicioService;
  const estudioId = new Types.ObjectId();

  const gastoModelMock: any = { find: jest.fn(), insertMany: jest.fn() };
  const importeModelMock: any = { findOneAndUpdate: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InicioService,
        { provide: getModelToken(GastoMensual.name), useValue: gastoModelMock },
        { provide: getModelToken(ImporteManualMes.name), useValue: importeModelMock },
        { provide: getModelToken(Reunion.name), useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(InicioService);
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
