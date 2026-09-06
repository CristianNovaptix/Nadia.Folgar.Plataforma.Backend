import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { ExtractosIaWatchdogService } from './extractos-ia-watchdog.service';
import { EstadoExtracto } from './schemas/extracto-bancario.schema';
import { RealtimeGateway } from '../realtime/realtime.gateway';

describe('ExtractosIaWatchdogService', () => {
  let service: ExtractosIaWatchdogService;
  const estudioId = new Types.ObjectId();
  const extractoId = new Types.ObjectId();

  const extractoModelMock: any = { find: jest.fn() };
  const realtimeGatewayMock = { emitToEstudio: jest.fn() };

  function buildExtractoEstancado(overrides: Record<string, unknown> = {}): any {
    return {
      _id: extractoId,
      estudioId,
      nombreArchivo: 'extracto.pdf',
      estado: EstadoExtracto.PROCESANDO,
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExtractosIaWatchdogService,
        { provide: getModelToken('ExtractoBancario'), useValue: extractoModelMock },
        { provide: RealtimeGateway, useValue: realtimeGatewayMock },
      ],
    }).compile();

    service = moduleRef.get(ExtractosIaWatchdogService);
  });

  it('fuerza a "error" cualquier extracto colgado en "procesando" y notifica por WebSocket', async () => {
    const instance = buildExtractoEstancado();
    extractoModelMock.find.mockReturnValue({ exec: jest.fn().mockResolvedValue([instance]) });

    const resultado = await service.purgarEstancados();

    expect(resultado).toEqual({ marcados: 1 });
    expect(instance.estado).toBe(EstadoExtracto.ERROR);
    expect(instance.mensajeError).toMatch(/tiempo máximo de procesamiento/i);
    expect(instance.save).toHaveBeenCalledTimes(1);
    expect(realtimeGatewayMock.emitToEstudio).toHaveBeenCalledWith(
      estudioId.toString(),
      'extracto:procesado',
      {
        extractoId: extractoId.toString(),
        estado: EstadoExtracto.ERROR,
        nombreArchivo: 'extracto.pdf',
      },
    );
  });

  it('no toca nada si no hay extractos estancados', async () => {
    extractoModelMock.find.mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });

    const resultado = await service.purgarEstancados();

    expect(resultado).toEqual({ marcados: 0 });
    expect(realtimeGatewayMock.emitToEstudio).not.toHaveBeenCalled();
  });

  it('filtra por estado "procesando" y por updatedAt más viejo que el umbral', async () => {
    extractoModelMock.find.mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });

    await service.purgarEstancados();

    expect(extractoModelMock.find).toHaveBeenCalledWith(
      expect.objectContaining({
        estado: EstadoExtracto.PROCESANDO,
        updatedAt: { $lt: expect.any(Date) },
      }),
    );
  });
});
