import { ClienteHistorialService } from '../clientes/cliente-historial.service';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { NotificacionesService } from './notificaciones.service';
import { Vencimiento, VencimientoEstado } from './schemas/vencimiento.schema';
import { ReglaNotificacion, CanalNotificacion } from './schemas/regla-notificacion.schema';
import {
  NotificacionEnviada,
  CanalEnvio,
  EstadoEnvio,
} from './schemas/notificacion-enviada.schema';
import { Cliente } from '../clientes/schemas/cliente.schema';
import { MESSAGING_PROVIDER } from './ports/messaging-provider.port';
import { PlantillaNotificacion } from './templates/notificacion.templates';

/** Mock encadenable: soporta tanto `.find(f).exec()` como `.find(f).sort().skip().limit().exec()`. */
function chainable(result: unknown): any {
  const query: any = {};
  query.sort = jest.fn().mockReturnValue(query);
  query.skip = jest.fn().mockReturnValue(query);
  query.limit = jest.fn().mockReturnValue(query);
  query.exec = jest.fn().mockResolvedValue(result);
  return query;
}

describe('NotificacionesService', () => {
  let service: NotificacionesService;
  const estudioId = new Types.ObjectId();

  const vencimientoModelMock: any = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    countDocuments: jest.fn(),
  };
  const reglaModelMock: any = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    countDocuments: jest.fn(),
  };
  const notificacionEnviadaModelMock: any = {
    find: jest.fn(),
    exists: jest.fn(),
    create: jest.fn(),
    countDocuments: jest.fn(),
  };
  const clienteModelMock: any = {
    findOne: jest.fn(),
  };
  const messagingProviderMock: any = {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    sendTemplateMessage: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificacionesService,
        { provide: getModelToken(Vencimiento.name), useValue: vencimientoModelMock },
        { provide: ClienteHistorialService, useValue: { registrarCambioDeOrigen: jest.fn() } },
        { provide: getModelToken(ReglaNotificacion.name), useValue: reglaModelMock },
        {
          provide: getModelToken(NotificacionEnviada.name),
          useValue: notificacionEnviadaModelMock,
        },
        { provide: getModelToken(Cliente.name), useValue: clienteModelMock },
        { provide: MESSAGING_PROVIDER, useValue: messagingProviderMock },
      ],
    }).compile();

    service = moduleRef.get(NotificacionesService);
  });

  describe('findAllVencimientos', () => {
    it('devuelve el shape paginado {data,total,page,limit} filtrando por estudioId', async () => {
      const vencimientos = [{ _id: new Types.ObjectId(), tipo: 'IVA' }];
      vencimientoModelMock.find.mockReturnValue(chainable(vencimientos));
      vencimientoModelMock.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(1) });

      const result = await service.findAllVencimientos({ page: 2, limit: 5 }, estudioId);

      expect(vencimientoModelMock.find).toHaveBeenCalledWith(
        expect.objectContaining({ estudioId }),
      );
      expect(result).toEqual({ data: vencimientos, total: 1, page: 2, limit: 5 });
    });

    it('aplica el default page=1/limit=10 cuando no se pasan', async () => {
      vencimientoModelMock.find.mockReturnValue(chainable([]));
      vencimientoModelMock.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      const result = await service.findAllVencimientos({}, estudioId);

      expect(result).toEqual({ data: [], total: 0, page: 1, limit: 10 });
    });
  });

  describe('evaluarReglas — evita duplicados', () => {
    const vencimientoId = new Types.ObjectId();
    const reglaId = new Types.ObjectId();
    const clienteId = new Types.ObjectId();
    const hoy = new Date();

    const vencimientoDoc: any = {
      _id: vencimientoId,
      tipo: 'Honorarios',
      clienteId,
      fecha: hoy,
      estado: VencimientoEstado.PENDIENTE,
      estudioId,
      save: jest.fn().mockResolvedValue(undefined),
    };

    const reglaDoc: any = {
      _id: reglaId,
      tipoVencimiento: 'Honorarios',
      offsetDias: 0,
      canal: CanalNotificacion.EMAIL,
      plantilla: PlantillaNotificacion.RECORDATORIO_HONORARIOS,
      activa: true,
      estudioId,
    };

    const clienteDoc: any = {
      _id: clienteId,
      nombre: 'Cliente Test',
      email: 'cliente@test.com.ar',
    };

    beforeEach(() => {
      vencimientoModelMock.find.mockReturnValue(chainable([vencimientoDoc]));
      reglaModelMock.find.mockReturnValue(chainable([reglaDoc]));
      clienteModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(clienteDoc) });
    });

    it('no reenvía si ya existe un registro para la combinación regla+vencimiento+día', async () => {
      notificacionEnviadaModelMock.exists.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      });

      const resultado = await service.evaluarReglas();

      expect(resultado).toEqual({ evaluados: 1, enviados: 0, omitidos: 1, errores: 0 });
      expect(messagingProviderMock.sendMessage).not.toHaveBeenCalled();
      expect(notificacionEnviadaModelMock.create).not.toHaveBeenCalled();
    });

    it('envía y registra la auditoría cuando todavía no se notificó', async () => {
      notificacionEnviadaModelMock.exists.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });
      notificacionEnviadaModelMock.create.mockResolvedValue({});

      const resultado = await service.evaluarReglas();

      expect(resultado).toEqual({ evaluados: 1, enviados: 1, omitidos: 0, errores: 0 });
      expect(messagingProviderMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(messagingProviderMock.sendMessage).toHaveBeenCalledWith(
        'cliente@test.com.ar',
        expect.stringContaining('Cliente Test'),
      );
      expect(notificacionEnviadaModelMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          vencimientoId,
          reglaId,
          clienteId,
          canal: CanalEnvio.EMAIL,
          estado: EstadoEnvio.ENVIADO,
          estudioId,
        }),
      );
      expect(vencimientoDoc.save).toHaveBeenCalled();
    });

    it('no dispara ninguna regla si offsetDias no matchea con el día de hoy', async () => {
      reglaModelMock.find.mockReturnValue(chainable([{ ...reglaDoc, offsetDias: 30 }]));
      notificacionEnviadaModelMock.exists.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      const resultado = await service.evaluarReglas();

      expect(resultado).toEqual({ evaluados: 1, enviados: 0, omitidos: 0, errores: 0 });
      expect(messagingProviderMock.sendMessage).not.toHaveBeenCalled();
    });
  });
});
