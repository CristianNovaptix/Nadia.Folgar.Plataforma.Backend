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
import { SecretCipherService } from '../common/crypto/secret-cipher.service';

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
  // Cifrado "de mentira" para los tests — no hace falta AES real, solo que
  // sea reversible y detectable como cifrado (nunca el texto plano tal cual).
  const secretCipherMock: any = {
    encrypt: jest.fn((texto: string) => `cifrado:${texto}`),
    decrypt: jest.fn((valor: string) => valor.replace(/^cifrado:/, '')),
  };

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
        { provide: SecretCipherService, useValue: secretCipherMock },
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

  it('rechaza un email duplicado entre clientes', async () => {
    clienteModelMock.findOne
      .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(null) })
      .mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue({ email: 'ya@folgar.com.ar' }),
      });

    await expect(
      service.create(
        { nombre: 'Cliente Test', cuit: '20-12345678-9', email: 'ya@folgar.com.ar' },
        estudioId,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('permite crear un cliente con el mismo email que ya tiene un Personal (dos roles, no es un duplicado)', async () => {
    // La validación del email de Cliente nunca consulta `User`/Personal —
    // la misma persona puede tener las dos cuentas con el mismo email.
    clienteModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    clienteModelMock.create.mockResolvedValue({});

    await service.create(
      { nombre: 'Cliente Test', cuit: '20-12345678-9', email: 'daiana.gencarelli@folgar.com.ar' },
      estudioId,
    );

    expect(userModelMock.findOne).not.toHaveBeenCalled();
    expect(clienteModelMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'daiana.gencarelli@folgar.com.ar' }),
    );
  });

  it('permite editar un cliente sin cambiar su propio email', async () => {
    const clienteId = new Types.ObjectId();
    const cliente: any = {
      _id: clienteId,
      email: 'ya@folgar.com.ar',
      save: jest.fn().mockResolvedValue(undefined),
      populate: jest.fn().mockResolvedValue(undefined),
    };
    cliente.toObject = jest.fn().mockImplementation(() => ({ ...cliente }));
    clienteModelMock.findOne.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(cliente),
    });

    await service.update(clienteId.toString(), { email: 'ya@folgar.com.ar' }, estudioId);

    expect(cliente.save).toHaveBeenCalled();
  });

  it('rechaza cambiar el email a uno que ya usa otro cliente', async () => {
    const clienteId = new Types.ObjectId();
    const cliente = {
      _id: clienteId,
      email: 'viejo@folgar.com.ar',
      save: jest.fn().mockResolvedValue(undefined),
      populate: jest.fn().mockResolvedValue(undefined),
    };
    clienteModelMock.findOne
      .mockReturnValueOnce({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(cliente),
      })
      .mockReturnValueOnce({
        exec: jest
          .fn()
          .mockResolvedValue({ _id: new Types.ObjectId(), email: 'nuevo@folgar.com.ar' }),
      });

    await expect(
      service.update(clienteId.toString(), { email: 'nuevo@folgar.com.ar' }, estudioId),
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

  describe('responsableTitular (seleccionable por cliente, default al/la titular)', () => {
    it('sin elegir nada a mano, cae al default (el/la titular del estudio)', async () => {
      const titularId = new Types.ObjectId();
      userModelMock.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([{ _id: titularId, nombre: 'Nadia Folgar' }]),
        }),
      });

      const clienteId = new Types.ObjectId();
      const cliente = {
        _id: clienteId,
        toObject: () => ({ _id: clienteId, responsableTitularId: null }),
      };
      clienteModelMock.findOne.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(cliente),
      });

      const result = (await service.findOne('507f1f77bcf86cd799439011', estudioId)) as {
        responsableTitular: { nombre: string } | null;
      };

      expect(result.responsableTitular).toEqual({ _id: titularId, nombre: 'Nadia Folgar' });
    });

    it('con alguien elegido a mano (poblado), usa esa persona en vez del default', async () => {
      const titularId = new Types.ObjectId();
      const elegidoId = new Types.ObjectId();
      userModelMock.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([{ _id: titularId, nombre: 'Nadia Folgar' }]),
        }),
      });

      const clienteId = new Types.ObjectId();
      const cliente = {
        _id: clienteId,
        toObject: () => ({
          _id: clienteId,
          responsableTitularId: { _id: elegidoId, nombre: 'Daiana Gencarelli' },
        }),
      };
      clienteModelMock.findOne.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(cliente),
      });

      const result = (await service.findOne('507f1f77bcf86cd799439011', estudioId)) as {
        responsableTitular: { nombre: string } | null;
      };

      expect(result.responsableTitular).toEqual({ _id: elegidoId, nombre: 'Daiana Gencarelli' });
    });

    it('al editar, guarda la elección y la devuelve poblada en la respuesta', async () => {
      const elegidoId = new Types.ObjectId();
      const clienteId = new Types.ObjectId();
      interface MockClienteConTitular {
        _id: Types.ObjectId;
        cuit: string;
        responsableTitularId?: { _id: Types.ObjectId; nombre: string };
        save: jest.Mock;
        populate: jest.Mock;
        toObject: jest.Mock;
      }
      const cliente: MockClienteConTitular = {
        _id: clienteId,
        cuit: '20123456789',
        save: jest.fn().mockResolvedValue(undefined),
        populate: jest.fn(),
        toObject: jest.fn(),
      };
      cliente.populate.mockImplementation((path: string) => {
        if (path === 'responsableTitularId') {
          cliente.responsableTitularId = { _id: elegidoId, nombre: 'Daiana Gencarelli' };
        }
        return Promise.resolve(undefined);
      });
      cliente.toObject.mockImplementation(() => ({ ...cliente }));
      clienteModelMock.findOne.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(cliente),
      });

      const result = (await service.update(
        clienteId.toString(),
        { responsableTitularId: elegidoId.toString() },
        estudioId,
      )) as { responsableTitular: { nombre: string } | null };

      expect(result.responsableTitular).toEqual({ _id: elegidoId, nombre: 'Daiana Gencarelli' });
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
      userModelMock.find.mockImplementation(
        (filter: { clienteId?: unknown; activo?: boolean }) => ({
          select: jest.fn().mockReturnValue({
            exec: jest
              .fn()
              .mockResolvedValue(
                filter.clienteId ? [{ clienteId, email: 'contacto-real@ejemplo.com' }] : [],
              ),
          }),
        }),
      );

      const result = (await service.findOne('507f1f77bcf86cd799439011', estudioId)) as {
        usuarioPortalEmail: string | null;
      };

      expect(result.usuarioPortalEmail).toBe('contacto-real@ejemplo.com');
      expect(userModelMock.find).toHaveBeenCalledWith(
        expect.objectContaining({ clienteId: { $in: [clienteId] }, activo: true }),
      );
    });

    it('null cuando el único usuario de portal de ese cliente está desactivado (login institucional viejo sin reparar)', async () => {
      const clienteId = new Types.ObjectId();
      const cliente = {
        _id: clienteId,
        toObject: () => ({ _id: clienteId, email: 'contacto-real@ejemplo.com' }),
      };
      clienteModelMock.findOne.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(cliente),
      });
      // El `find` real filtra por `activo: true` — un usuario desactivado nunca llega
      // a este resultado, así que el mock ya representa lo que Mongo devolvería.
      userModelMock.find.mockReturnValue({
        select: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
      });

      const result = (await service.findOne('507f1f77bcf86cd799439011', estudioId)) as {
        usuarioPortalEmail: string | null;
      };

      expect(result.usuarioPortalEmail).toBeNull();
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

  describe('credenciales de organismos (ARCA/ARBA/AGIP)', () => {
    it('cifra la contraseña al crear y solo devuelve un preview, nunca la cifrada', async () => {
      clienteModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      clienteModelMock.create.mockResolvedValue({
        toObject: () => ({
          nombre: 'Cliente Test',
          credencialesArca: {
            usuario: 'user.arca',
            passwordCifrada: 'cifrado:secreta123',
            passwordPreview: '····a123',
          },
        }),
      });

      const result = (await service.create(
        {
          nombre: 'Cliente Test',
          cuit: '20-12345678-9',
          regimenFiscal: RegimenFiscal.MONOTRIBUTO,
          credencialesArca: { usuario: 'user.arca', password: 'secreta123' },
        },
        estudioId,
      )) as {
        credencialesArca: { usuario: string; passwordPreview: string; passwordCifrada?: string };
      };

      expect(secretCipherMock.encrypt).toHaveBeenCalledWith('secreta123');
      expect(clienteModelMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          credencialesArca: {
            usuario: 'user.arca',
            passwordCifrada: 'cifrado:secreta123',
            passwordPreview: '····a123',
          },
        }),
      );
      expect(result.credencialesArca).toEqual({
        usuario: 'user.arca',
        passwordPreview: '····a123',
      });
      expect(result.credencialesArca.passwordCifrada).toBeUndefined();
    });

    interface MockClienteConCredencial {
      _id: Types.ObjectId;
      cuit: string;
      credencialesArba: unknown;
      save: jest.Mock;
      populate: jest.Mock;
      toObject: jest.Mock;
    }

    function mockClienteConCredencial(credencialesArba: unknown): MockClienteConCredencial {
      const cliente: MockClienteConCredencial = {
        _id: new Types.ObjectId(),
        cuit: '20123456789',
        credencialesArba,
        save: jest.fn().mockResolvedValue(undefined),
        populate: jest.fn().mockResolvedValue(undefined),
        toObject: jest.fn(),
      };
      cliente.toObject.mockImplementation(() => ({ ...cliente }));
      clienteModelMock.findOne.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(cliente),
      });
      return cliente;
    }

    it('al editar sin mandar password conserva la ya cifrada, solo actualiza el usuario', async () => {
      const cliente = mockClienteConCredencial({
        usuario: 'user.viejo',
        passwordCifrada: 'cifrado:vieja',
        passwordPreview: '····ieja',
      });

      await service.update(
        cliente._id.toString(),
        { credencialesArba: { usuario: 'user.nuevo' } },
        estudioId,
      );

      expect(cliente.credencialesArba).toEqual({
        usuario: 'user.nuevo',
        passwordCifrada: 'cifrado:vieja',
        passwordPreview: '····ieja',
      });
    });

    it('al editar mandando una password nueva la reemplaza', async () => {
      const cliente = mockClienteConCredencial({
        usuario: 'user.viejo',
        passwordCifrada: 'cifrado:vieja',
        passwordPreview: '····ieja',
      });

      await service.update(
        cliente._id.toString(),
        { credencialesArba: { usuario: 'user.nuevo', password: 'nueva456' } },
        estudioId,
      );

      expect(cliente.credencialesArba).toEqual({
        usuario: 'user.nuevo',
        passwordCifrada: 'cifrado:nueva456',
        passwordPreview: '····a456',
      });
    });

    it('no toca las credenciales si el campo viene ausente del body', async () => {
      const credencialesArba = {
        usuario: 'user.arca',
        passwordCifrada: 'cifrado:x',
        passwordPreview: '····xxxx',
      };
      const cliente = mockClienteConCredencial(credencialesArba);

      await service.update(cliente._id.toString(), { nombre: 'Nuevo nombre' }, estudioId);

      expect(cliente.credencialesArba).toBe(credencialesArba);
    });

    describe('revelarCredencial ("Ver contraseña")', () => {
      it('descifra y devuelve la contraseña real, nunca la cifrada', async () => {
        const cliente = mockClienteConCredencial(undefined);
        (cliente as unknown as { credencialesArca: unknown }).credencialesArca = {
          usuario: 'user.arca',
          passwordCifrada: 'cifrado:secreta123',
          passwordPreview: '····a123',
        };

        const result = await service.revelarCredencial(
          cliente._id.toString(),
          'arca',
          estudioId,
        );

        expect(secretCipherMock.decrypt).toHaveBeenCalledWith('cifrado:secreta123');
        expect(result).toEqual({ usuario: 'user.arca', password: 'secreta123' });
      });

      it('lanza NotFoundException si ese organismo todavía no tiene contraseña cargada', async () => {
        const cliente = mockClienteConCredencial(undefined);

        await expect(
          service.revelarCredencial(cliente._id.toString(), 'arba', estudioId),
        ).rejects.toThrow(NotFoundException);
      });
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

    it('rechaza crearlo si el cliente ya tiene un usuario de portal ACTIVO creado', async () => {
      const cliente = mockClienteConEmail();
      userModelMock.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ clienteId: cliente._id, activo: true }),
      });

      await expect(service.crearUsuarioPortal(cliente._id.toString(), estudioId)).rejects.toThrow(
        ConflictException,
      );
      expect(userModelMock.create).not.toHaveBeenCalled();
    });

    it('repara en vez de chocar cuando el usuario de portal existente está DESACTIVADO (login institucional viejo)', async () => {
      const cliente = mockClienteConEmail();
      const usuarioViejo = {
        _id: new Types.ObjectId(),
        clienteId: cliente._id,
        email: 'cliente.test@folgar.com.ar',
        emailInstitucional: undefined as string | undefined,
        passwordHash: 'hash-viejo',
        credencialesGeneradas: false,
        activo: false,
        save: jest.fn().mockResolvedValue(undefined),
      };
      userModelMock.findOne
        .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(usuarioViejo) })
        .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(null) });

      const { password, emailEnviado } = await service.crearUsuarioPortal(
        cliente._id.toString(),
        estudioId,
      );

      expect(userModelMock.create).not.toHaveBeenCalled();
      expect(usuarioViejo.save).toHaveBeenCalled();
      expect(usuarioViejo.email).toBe('cliente@ejemplo.com');
      expect(usuarioViejo.emailInstitucional).toBeUndefined();
      expect(usuarioViejo.activo).toBe(true);
      expect(usuarioViejo.credencialesGeneradas).toBe(true);
      expect(typeof password).toBe('string');
      expect(emailEnviado).toBe(true);
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
