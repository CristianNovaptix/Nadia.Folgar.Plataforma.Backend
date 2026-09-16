import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PortalClientesService } from './portal-clientes.service';
import { Documento } from './schemas/documento.schema';
import { Comunicado } from './schemas/comunicado.schema';
import { Cliente } from '../clientes/schemas/cliente.schema';
import { MESSAGING_PROVIDER } from '../notificaciones/ports/messaging-provider.port';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateDocumentoDto } from './dto/create-documento.dto';
import { CreateComunicadoDto } from './dto/create-comunicado.dto';

/** Mock encadenable: soporta `.find(f).sort().skip().limit().exec()`. */
function chainable(result: unknown): any {
  const query: any = {};
  query.sort = jest.fn().mockReturnValue(query);
  query.skip = jest.fn().mockReturnValue(query);
  query.limit = jest.fn().mockReturnValue(query);
  query.exec = jest.fn().mockResolvedValue(result);
  return query;
}

describe('PortalClientesService', () => {
  let service: PortalClientesService;
  const estudioId = new Types.ObjectId();

  const documentoModelMock: any = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    countDocuments: jest.fn(),
  };
  const comunicadoModelMock: any = {
    find: jest.fn(),
    findOne: jest.fn(),
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

  const adminUser: AuthenticatedUser = {
    userId: 'admin-1',
    email: 'admin@folgar.com.ar',
    roles: ['admin'],
    permissions: [],
    estudioId: estudioId.toString(),
    debeCambiarPassword: false,
  };

  function buildClienteUser(clienteId?: string): AuthenticatedUser {
    return {
      userId: 'cliente-user-1',
      email: 'cliente@test.com.ar',
      roles: ['cliente'],
      permissions: ['portal.documentos.read'],
      estudioId: estudioId.toString(),
      debeCambiarPassword: false,
      clienteId,
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        PortalClientesService,
        { provide: getModelToken(Documento.name), useValue: documentoModelMock },
        { provide: getModelToken(Comunicado.name), useValue: comunicadoModelMock },
        { provide: getModelToken(Cliente.name), useValue: clienteModelMock },
        { provide: MESSAGING_PROVIDER, useValue: messagingProviderMock },
      ],
    }).compile();

    service = moduleRef.get(PortalClientesService);
  });

  describe('findDocumentosParaUsuario — control de acceso', () => {
    it('un admin puede filtrar por cualquier clienteId que venga en el query', async () => {
      documentoModelMock.find.mockReturnValue(chainable([]));
      documentoModelMock.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      const clienteIdQuery = new Types.ObjectId().toString();
      await service.findDocumentosParaUsuario({ clienteId: clienteIdQuery }, adminUser);

      expect(documentoModelMock.find).toHaveBeenCalledWith(
        expect.objectContaining({ estudioId, clienteId: new Types.ObjectId(clienteIdQuery) }),
      );
    });

    it('un admin sin clienteId en el query ve todos los documentos del estudio', async () => {
      documentoModelMock.find.mockReturnValue(chainable([]));
      documentoModelMock.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      await service.findDocumentosParaUsuario({}, adminUser);

      const filterUsed = documentoModelMock.find.mock.calls[0][0];
      expect(filterUsed).toEqual({ estudioId });
    });

    it('CRÍTICO: un usuario rol cliente IGNORA el clienteId del query y solo ve lo propio', async () => {
      documentoModelMock.find.mockReturnValue(chainable([]));
      documentoModelMock.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      const propioClienteId = new Types.ObjectId().toString();
      const otroClienteId = new Types.ObjectId().toString(); // intento de acceder a otro cliente por URL
      const user = buildClienteUser(propioClienteId);

      await service.findDocumentosParaUsuario({ clienteId: otroClienteId }, user);

      const filterUsed = documentoModelMock.find.mock.calls[0][0];
      expect(filterUsed.clienteId).toEqual(new Types.ObjectId(propioClienteId));
      expect(filterUsed.clienteId.toString()).not.toBe(otroClienteId);
    });

    it('un usuario rol cliente sin clienteId asociado en el JWT no ve ningún documento', async () => {
      const user = buildClienteUser(undefined);

      const result = await service.findDocumentosParaUsuario({}, user);

      expect(result).toEqual({ data: [], total: 0, page: 1, limit: 10 });
      expect(documentoModelMock.find).not.toHaveBeenCalled();
    });
  });

  describe('createDocumento — notificación al cliente (FOLGAR-026)', () => {
    const clienteId = new Types.ObjectId();
    const clienteDoc: any = {
      _id: clienteId,
      nombre: 'Cliente Test',
      email: 'cliente@test.com.ar',
    };
    const dto: CreateDocumentoDto = {
      clienteId: clienteId.toString(),
      nombre: 'Balance 2026.pdf',
      contentType: 'application/pdf',
      contenidoBase64: 'ZGF0YQ==',
      tamanioBytes: 4,
    };

    beforeEach(() => {
      clienteModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(clienteDoc) });
      documentoModelMock.create.mockResolvedValue({ _id: new Types.ObjectId(), ...dto });
    });

    it('crea el documento y dispara una notificación al email del cliente', async () => {
      const result = await service.createDocumento(dto, estudioId);

      expect(documentoModelMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ clienteId, estudioId, nombre: dto.nombre }),
      );
      expect(messagingProviderMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(messagingProviderMock.sendMessage).toHaveBeenCalledWith(
        'cliente@test.com.ar',
        expect.stringContaining('Balance 2026.pdf'),
      );
      expect(result).toBeDefined();
    });

    it('un error del MessagingProvider NO rompe la creación del documento', async () => {
      messagingProviderMock.sendMessage.mockRejectedValueOnce(new Error('SMTP caído'));

      await expect(service.createDocumento(dto, estudioId)).resolves.toBeDefined();
      expect(documentoModelMock.create).toHaveBeenCalled();
    });

    it('rechaza el alta si el cliente no existe en ese estudio', async () => {
      clienteModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      await expect(service.createDocumento(dto, estudioId)).rejects.toThrow(NotFoundException);
      expect(documentoModelMock.create).not.toHaveBeenCalled();
    });

    it('no notifica (pero no falla) si el cliente no tiene email cargado', async () => {
      clienteModelMock.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: clienteId, nombre: 'Sin mail', email: undefined }),
      });

      await expect(service.createDocumento(dto, estudioId)).resolves.toBeDefined();
      expect(messagingProviderMock.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('findComunicadosParaUsuario — control de acceso', () => {
    it('un usuario rol cliente ve los propios + los generales, ignorando el clienteId del query', async () => {
      comunicadoModelMock.find.mockReturnValue(chainable([]));
      comunicadoModelMock.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      const propioClienteId = new Types.ObjectId().toString();
      const otroClienteId = new Types.ObjectId().toString();
      const user = buildClienteUser(propioClienteId);

      await service.findComunicadosParaUsuario({ clienteId: otroClienteId }, user);

      const filterUsed = comunicadoModelMock.find.mock.calls[0][0];
      expect(filterUsed.$or).toEqual(
        expect.arrayContaining([
          { clienteId: new Types.ObjectId(propioClienteId) },
          { clienteId: null },
        ]),
      );
    });

    it('un admin sin clienteId en el query ve todos los comunicados del estudio', async () => {
      comunicadoModelMock.find.mockReturnValue(chainable([]));
      comunicadoModelMock.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      await service.findComunicadosParaUsuario({}, adminUser);

      const filterUsed = comunicadoModelMock.find.mock.calls[0][0];
      expect(filterUsed).toEqual({ estudioId });
    });
  });

  describe('createComunicado', () => {
    it('dirigido a un cliente puntual: notifica y guarda el clienteId', async () => {
      const clienteId = new Types.ObjectId();
      const clienteDoc: any = {
        _id: clienteId,
        nombre: 'Cliente Test',
        email: 'cliente@test.com.ar',
      };
      clienteModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(clienteDoc) });
      comunicadoModelMock.create.mockResolvedValue({ _id: new Types.ObjectId() });

      const dto: CreateComunicadoDto = {
        titulo: 'Vencimiento próximo',
        cuerpo: 'Recordá presentar el IVA antes del 20.',
        clienteId: clienteId.toString(),
      };

      await service.createComunicado(dto, estudioId);

      expect(comunicadoModelMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ clienteId, estudioId }),
      );
      expect(messagingProviderMock.sendMessage).toHaveBeenCalledWith(
        'cliente@test.com.ar',
        expect.stringContaining('Vencimiento próximo'),
      );
    });

    it('para TODOS los clientes (sin clienteId): no dispara notificación individual', async () => {
      comunicadoModelMock.create.mockResolvedValue({ _id: new Types.ObjectId() });

      const dto: CreateComunicadoDto = {
        titulo: 'Feriado del estudio',
        cuerpo: 'El estudio permanece cerrado el próximo lunes.',
      };

      await service.createComunicado(dto, estudioId);

      expect(comunicadoModelMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ clienteId: undefined, estudioId }),
      );
      expect(clienteModelMock.findOne).not.toHaveBeenCalled();
      expect(messagingProviderMock.sendMessage).not.toHaveBeenCalled();
    });
  });
});
