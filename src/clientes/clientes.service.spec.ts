import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import * as argon2 from 'argon2';
import { ClientesService } from './clientes.service';
import { Cliente, RegimenFiscal } from './schemas/cliente.schema';
import { User } from '../users/schemas/user.schema';
import { Role } from '../roles/schemas/role.schema';
import { IntegracionIa } from '../configuracion/schemas/integracion-ia.schema';
import { ProveedorIA } from '../common/enums/proveedor-ia.enum';
import { MailService } from '../common/mail/mail.service';

describe('ClientesService', () => {
  let service: ClientesService;
  const estudioId = new Types.ObjectId();
  const clienteModelMock: any = {
    findOne: jest.fn(),
    find: jest.fn(),
    countDocuments: jest.fn(),
    create: jest.fn(),
  };
  // Sin titulares en la mayoría de los tests (`find` de userModel resuelve
  // `[]`) para que `responsablesEfectivos` no interfiera con las
  // aserciones sobre `responsableIds` — se prueba aparte más abajo.
  const userModelMock: any = {
    find: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
    }),
    findOne: jest.fn(),
    create: jest.fn(),
  };
  const roleModelMock: any = { findOne: jest.fn() };
  const integracionIaModelMock: any = { exists: jest.fn() };
  const mailServiceMock: any = { enviarCredenciales: jest.fn().mockResolvedValue(true) };

  beforeEach(async () => {
    jest.clearAllMocks();
    userModelMock.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
    });
    integracionIaModelMock.exists.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    mailServiceMock.enviarCredenciales.mockResolvedValue(true);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ClientesService,
        { provide: getModelToken(Cliente.name), useValue: clienteModelMock },
        { provide: getModelToken(User.name), useValue: userModelMock },
        { provide: getModelToken(Role.name), useValue: roleModelMock },
        { provide: getModelToken(IntegracionIa.name), useValue: integracionIaModelMock },
        { provide: MailService, useValue: mailServiceMock },
      ],
    }).compile();

    service = moduleRef.get(ClientesService);
  });

  it('normaliza el CUIT (sin guiones) antes de guardar', async () => {
    clienteModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    clienteModelMock.create.mockResolvedValue({});

    await service.create(
      {
        nombre: 'Cliente Test',
        cuit: '20-12345678-9',
        regimenFiscal: RegimenFiscal.MONOTRIBUTO,
      },
      estudioId,
    );

    expect(clienteModelMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ cuit: '20123456789' }),
    );
  });

  it('rechaza un CUIT duplicado', async () => {
    clienteModelMock.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ cuit: '20123456789' }),
    });

    await expect(
      service.create(
        {
          nombre: 'Cliente Test',
          cuit: '20-12345678-9',
          regimenFiscal: RegimenFiscal.MONOTRIBUTO,
        },
        estudioId,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('findOne lanza NotFoundException si no existe en el estudio', async () => {
    clienteModelMock.findOne.mockReturnValue({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(null),
    });

    await expect(service.findOne('507f1f77bcf86cd799439011', estudioId)).rejects.toThrow(
      NotFoundException,
    );
  });

  describe('responsableIds (asignación a "Personal", ahora múltiple)', () => {
    interface MockCliente {
      _id: Types.ObjectId;
      cuit: string;
      responsableIds?: Types.ObjectId[];
      save: jest.Mock;
      populate: jest.Mock;
      toObject: jest.Mock;
    }

    function mockCliente(overrides: Partial<MockCliente> = {}): MockCliente {
      const cliente: MockCliente = {
        _id: new Types.ObjectId(),
        cuit: '20123456789',
        responsableIds: [],
        save: jest.fn().mockResolvedValue(undefined),
        populate: jest.fn().mockResolvedValue(undefined),
        toObject: jest.fn(),
        ...overrides,
      };
      cliente.toObject.mockImplementation(() => ({ ...cliente }));
      clienteModelMock.findOne.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(cliente),
      });
      return cliente;
    }

    it('asigna responsableIds al crear', async () => {
      clienteModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      clienteModelMock.create.mockResolvedValue({});
      const responsableIds = [new Types.ObjectId().toString()];

      await service.create(
        {
          nombre: 'Cliente Test',
          cuit: '20-12345678-9',
          regimenFiscal: RegimenFiscal.MONOTRIBUTO,
          responsableIds,
        },
        estudioId,
      );

      expect(clienteModelMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ responsableIds }),
      );
    });

    it('vacía la asignación cuando se manda responsableIds: []', async () => {
      const responsableIds = [new Types.ObjectId()];
      const cliente = mockCliente({ responsableIds });

      await service.update(cliente._id.toString(), { responsableIds: [] }, estudioId);

      expect(cliente.responsableIds).toEqual([]);
      expect(cliente.save).toHaveBeenCalled();
    });

    it('no toca la asignación si responsableIds viene ausente (undefined)', async () => {
      const responsableIds = [new Types.ObjectId()];
      const cliente = mockCliente({ responsableIds });

      await service.update(cliente._id.toString(), { nombre: 'Nuevo nombre' }, estudioId);

      expect(cliente.responsableIds).toBe(responsableIds);
    });

    it('reemplaza la asignación completa con los IDs mandados (agregar sin perder a los demás lo arma el Frontend)', async () => {
      const cliente = mockCliente();
      const nuevoId = new Types.ObjectId().toString();
      const yaExistiaId = new Types.ObjectId().toString();

      await service.update(
        cliente._id.toString(),
        { responsableIds: [yaExistiaId, nuevoId] },
        estudioId,
      );

      expect(cliente.responsableIds?.map((id) => id.toString())).toEqual([yaExistiaId, nuevoId]);
    });
  });

  describe('responsablesEfectivos (esTitular automático)', () => {
    it('suma a quien tenga esTitular aunque no esté en responsableIds', async () => {
      const titularId = new Types.ObjectId();
      userModelMock.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          exec: jest
            .fn()
            .mockResolvedValue([{ _id: titularId, nombre: 'Nadia Folgar', email: undefined }]),
        }),
      });

      const clienteId = new Types.ObjectId();
      const cliente = {
        _id: clienteId,
        toObject: () => ({ _id: clienteId, responsableIds: [] }),
      };
      clienteModelMock.findOne.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(cliente),
      });

      const result = (await service.findOne('507f1f77bcf86cd799439011', estudioId)) as {
        responsablesEfectivos: Array<{ nombre: string }>;
      };

      expect(result.responsablesEfectivos).toEqual([
        { _id: titularId, nombre: 'Nadia Folgar', email: undefined },
      ]);
      // No filtra por rol — pide directamente `esTitular: true`, no
      // "cualquier admin" (hay una cuenta de admin de pruebas que no debe
      // figurar acá, ver `user.schema.ts`).
      expect(userModelMock.find).toHaveBeenCalledWith(expect.objectContaining({ esTitular: true }));
    });

    it('NO se mezcla con "Personal a cargo" (responsableIds) — son dos cosas separadas', async () => {
      const titularId = new Types.ObjectId();
      const daianaId = new Types.ObjectId();
      userModelMock.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([{ _id: titularId, nombre: 'Nadia Folgar' }]),
        }),
      });

      // El cliente tiene a Daiana como "Personal a cargo" (responsableIds)
      // — pedido explícito del usuario: eso NO debe aparecer en
      // `responsablesEfectivos`, que es solo el/la titular.
      const clienteId = new Types.ObjectId();
      const cliente = {
        _id: clienteId,
        toObject: () => ({
          _id: clienteId,
          responsableIds: [{ _id: daianaId, nombre: 'Daiana Gencarelli' }],
        }),
      };
      clienteModelMock.findOne.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(cliente),
      });

      const result = (await service.findOne('507f1f77bcf86cd799439011', estudioId)) as {
        responsablesEfectivos: Array<{ nombre: string }>;
      };

      expect(result.responsablesEfectivos).toEqual([{ _id: titularId, nombre: 'Nadia Folgar' }]);
    });
  });

  describe('usuarioPortalEmail (login del usuario de portal, si ya lo tiene — el email real del cliente)', () => {
    it('expone el email del usuario de portal ya creado', async () => {
      const clienteId = new Types.ObjectId();
      const cliente = {
        _id: clienteId,
        toObject: () => ({ _id: clienteId, email: 'contacto-real@ejemplo.com' }),
      };
      clienteModelMock.findOne.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(cliente),
      });
      userModelMock.find.mockImplementation((filter: { clienteId?: unknown }) => ({
        select: jest.fn().mockReturnValue({
          exec: jest
            .fn()
            .mockResolvedValue(
              filter.clienteId ? [{ clienteId, email: 'contacto-real@ejemplo.com' }] : [],
            ),
        }),
      }));

      const result = (await service.findOne('507f1f77bcf86cd799439011', estudioId)) as {
        usuarioPortalEmail: string | null;
      };

      expect(result.usuarioPortalEmail).toBe('contacto-real@ejemplo.com');
    });

    it('null cuando ese cliente todavía no tiene un usuario de portal creado', async () => {
      const clienteId = new Types.ObjectId();
      const cliente = { _id: clienteId, toObject: () => ({ _id: clienteId }) };
      clienteModelMock.findOne.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(cliente),
      });

      const result = (await service.findOne('507f1f77bcf86cd799439011', estudioId)) as {
        usuarioPortalEmail: string | null;
      };

      expect(result.usuarioPortalEmail).toBeNull();
    });
  });

  describe('motorIaPreferido', () => {
    it('rechaza setear un motor que el estudio no tiene conectado', async () => {
      clienteModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      integracionIaModelMock.exists.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      await expect(
        service.create(
          {
            nombre: 'Cliente Test',
            cuit: '20-12345678-9',
            regimenFiscal: RegimenFiscal.MONOTRIBUTO,
            motorIaPreferido: ProveedorIA.OPENAI,
          },
          estudioId,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(clienteModelMock.create).not.toHaveBeenCalled();
    });

    it('permite setear un motor que el estudio si tiene conectado', async () => {
      clienteModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      clienteModelMock.create.mockResolvedValue({});
      integracionIaModelMock.exists.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      });

      await service.create(
        {
          nombre: 'Cliente Test',
          cuit: '20-12345678-9',
          regimenFiscal: RegimenFiscal.MONOTRIBUTO,
          motorIaPreferido: ProveedorIA.OPENAI,
        },
        estudioId,
      );

      expect(integracionIaModelMock.exists).toHaveBeenCalledWith({
        estudioId,
        proveedor: ProveedorIA.OPENAI,
      });
      expect(clienteModelMock.create).toHaveBeenCalled();
    });
  });

  describe('crearUsuarioPortal', () => {
    function mockClienteConEmail(overrides: Partial<Record<string, unknown>> = {}) {
      const cliente = {
        _id: new Types.ObjectId(),
        nombre: 'Cliente Test',
        email: 'cliente@ejemplo.com',
        ...overrides,
      };
      clienteModelMock.findOne.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(cliente),
      });
      return cliente;
    }

    it('crea el usuario de portal con el email REAL del cliente como login (no uno institucional) y le avisa ahí mismo', async () => {
      const cliente = mockClienteConEmail();
      const rolClienteId = new Types.ObjectId();
      // 1ra llamada: ¿ya tiene un usuario de portal? (por clienteId). 2da:
      // ¿ese email ya está tomado por otro usuario? — ninguna de las dos, sigue de largo.
      userModelMock.findOne
        .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(null) })
        .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(null) });
      roleModelMock.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: rolClienteId, nombre: 'cliente' }),
      });
      userModelMock.create.mockResolvedValue({
        _id: new Types.ObjectId(),
        nombre: cliente.nombre,
        email: 'cliente@ejemplo.com',
      });

      const { password, emailEnviado } = await service.crearUsuarioPortal(
        cliente._id.toString(),
        estudioId,
      );

      expect(userModelMock.findOne).toHaveBeenNthCalledWith(1, { clienteId: cliente._id });
      expect(roleModelMock.findOne).toHaveBeenCalledWith({ nombre: 'cliente' });
      const createArgs = userModelMock.create.mock.calls[0][0];
      // El login ES el email real ya cargado — pedido explícito del usuario, revierte el criterio anterior.
      expect(createArgs.email).toBe('cliente@ejemplo.com');
      expect(createArgs.credencialesGeneradas).toBe(true);
      expect(createArgs.roleIds).toEqual([rolClienteId]);
      expect(createArgs.clienteId).toBe(cliente._id);
      expect(typeof password).toBe('string');
      expect(mailServiceMock.enviarCredenciales).toHaveBeenCalledWith({
        to: 'cliente@ejemplo.com',
        usuario: 'cliente@ejemplo.com',
        nombre: cliente.nombre,
        password,
        esCliente: true,
      });
      expect(emailEnviado).toBe(true);
    });

    it('rechaza crearlo si el cliente no tiene un email cargado — sin eso no hay con qué loguearse', async () => {
      const cliente = mockClienteConEmail({ email: undefined });

      // Rechaza antes de llegar a consultar `userModel` — ni el chequeo de
      // "ya tiene usuario de portal" ni el de "email ya tomado" se llegan a correr.
      await expect(service.crearUsuarioPortal(cliente._id.toString(), estudioId)).rejects.toThrow(
        BadRequestException,
      );
      expect(userModelMock.findOne).not.toHaveBeenCalled();
      expect(userModelMock.create).not.toHaveBeenCalled();
    });

    it('rechaza crearlo si ese email ya lo usa otro usuario', async () => {
      const cliente = mockClienteConEmail();
      userModelMock.findOne
        .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(null) })
        .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue({ email: cliente.email }) });

      await expect(service.crearUsuarioPortal(cliente._id.toString(), estudioId)).rejects.toThrow(
        ConflictException,
      );
      expect(userModelMock.create).not.toHaveBeenCalled();
    });

    it('rechaza crearlo si el cliente ya tiene un usuario de portal creado', async () => {
      const cliente = mockClienteConEmail();
      userModelMock.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ clienteId: cliente._id }),
      });

      await expect(service.crearUsuarioPortal(cliente._id.toString(), estudioId)).rejects.toThrow(
        ConflictException,
      );
      expect(userModelMock.create).not.toHaveBeenCalled();
    });
  });

  describe('regenerarPasswordPortal ("Cambiar contraseña" — resetea, nunca recupera la original)', () => {
    function mockCliente(overrides: Partial<Record<string, unknown>> = {}) {
      const cliente = { _id: new Types.ObjectId(), nombre: 'Cliente Test', ...overrides };
      clienteModelMock.findOne.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(cliente),
      });
      return cliente;
    }

    function mockUsuarioPortal(overrides: Partial<Record<string, unknown>> = {}) {
      const usuarioPortal = {
        _id: new Types.ObjectId(),
        nombre: 'Cliente Test',
        email: 'cliente.test@folgar.com.ar',
        passwordHash: 'hash-viejo',
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides,
      };
      userModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(usuarioPortal) });
      return usuarioPortal;
    }

    it('rechaza si el cliente todavía no tiene un usuario de portal creado', async () => {
      const cliente = mockCliente();
      userModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      await expect(
        service.regenerarPasswordPortal(cliente._id.toString(), estudioId),
      ).rejects.toThrow(NotFoundException);
    });

    it('genera una contraseña nueva sin tocar el email del usuario de portal, marca debeCambiarPassword', async () => {
      const cliente = mockCliente();
      const usuarioPortal = mockUsuarioPortal();

      const { password } = await service.regenerarPasswordPortal(cliente._id.toString(), estudioId);

      expect(usuarioPortal.email).toBe('cliente.test@folgar.com.ar');
      expect(usuarioPortal.save).toHaveBeenCalled();
      expect(usuarioPortal.passwordHash).not.toBe('hash-viejo');
      expect((usuarioPortal as any).debeCambiarPassword).toBe(true);
      expect(typeof password).toBe('string');
    });

    it('usa la contraseña manual en vez de generar una, si se la mandan', async () => {
      const cliente = mockCliente();
      const usuarioPortal = mockUsuarioPortal();

      const { password } = await service.regenerarPasswordPortal(
        cliente._id.toString(),
        estudioId,
        'unaClaveManual123',
      );

      expect(password).toBe('unaClaveManual123');
      await expect(argon2.verify(usuarioPortal.passwordHash, 'unaClaveManual123')).resolves.toBe(
        true,
      );
    });

    it('avisa por mail al email real del cliente (nunca al login institucional)', async () => {
      const cliente = mockCliente({ email: 'cliente@ejemplo.com' });
      mockUsuarioPortal();

      const { emailEnviado } = await service.regenerarPasswordPortal(
        cliente._id.toString(),
        estudioId,
      );

      expect(mailServiceMock.enviarCredenciales).toHaveBeenCalledWith({
        to: 'cliente@ejemplo.com',
        usuario: 'cliente.test@folgar.com.ar',
        nombre: cliente.nombre,
        password: expect.any(String),
        esCliente: true,
      });
      expect(emailEnviado).toBe(true);
    });

    it('no manda mail si el cliente no tiene un email real cargado', async () => {
      const cliente = mockCliente();
      mockUsuarioPortal();

      const { emailEnviado } = await service.regenerarPasswordPortal(
        cliente._id.toString(),
        estudioId,
      );

      expect(mailServiceMock.enviarCredenciales).not.toHaveBeenCalled();
      expect(emailEnviado).toBe(false);
    });
  });
});
