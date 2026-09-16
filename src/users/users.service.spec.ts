import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { Types } from 'mongoose';
import * as argon2 from 'argon2';
import { UsersService } from './users.service';
import { User } from './schemas/user.schema';
import { MailService } from '../common/mail/mail.service';

describe('UsersService', () => {
  let service: UsersService;
  const userModelMock: any = {
    findOne: jest.fn(),
    findById: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
  };
  const mailServiceMock: any = {
    enviarCredenciales: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mailServiceMock.enviarCredenciales.mockResolvedValue(true);
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getModelToken(User.name), useValue: userModelMock },
        { provide: MailService, useValue: mailServiceMock },
      ],
    }).compile();

    service = moduleRef.get(UsersService);
  });

  it('rechaza crear un usuario con email ya existente', async () => {
    userModelMock.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ email: 'ya@existe.com' }),
    });

    await expect(
      service.create(
        { email: 'ya@existe.com', password: 'password123', nombre: 'Test', roleIds: [] },
        new Types.ObjectId(),
      ),
    ).rejects.toThrow(ConflictException);
    expect(userModelMock.create).not.toHaveBeenCalled();
  });

  it('hashea la contraseña antes de crear el usuario', async () => {
    userModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    userModelMock.create.mockResolvedValue({
      email: 'nuevo@folgar.com',
      populate: jest.fn().mockResolvedValue(undefined),
    });

    await service.create(
      { email: 'Nuevo@Folgar.com', password: 'password123', nombre: 'Test', roleIds: [] },
      new Types.ObjectId(),
    );

    const createArgs = userModelMock.create.mock.calls[0][0];
    expect(createArgs.email).toBe('nuevo@folgar.com');
    expect(createArgs.passwordHash).not.toBe('password123');
    expect(createArgs.passwordHash.length).toBeGreaterThan(20);
  });

  it('persiste teléfono y régimen fiscal ("contacto" de Personal) al crear', async () => {
    userModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    userModelMock.create.mockResolvedValue({
      email: 'nueva@folgar.com',
      populate: jest.fn().mockResolvedValue(undefined),
    });

    await service.create(
      {
        email: 'nueva@folgar.com',
        password: 'password123',
        nombre: 'Nueva Contadora',
        roleIds: [],
        telefono: '+54 9 291 555-1234',
        regimenFiscal: 'monotributo' as any,
      },
      new Types.ObjectId(),
    );

    const createArgs = userModelMock.create.mock.calls[0][0];
    expect(createArgs.telefono).toBe('+54 9 291 555-1234');
    expect(createArgs.regimenFiscal).toBe('monotributo');
  });

  it('permite crear un usuario sin email (pedido explícito: "Personal" sin email todavía) sin chequear duplicados', async () => {
    userModelMock.create.mockResolvedValue({
      email: undefined,
      populate: jest.fn().mockResolvedValue(undefined),
    });

    await service.create(
      { password: 'password123', nombre: 'Nadia Folgar', roleIds: [] },
      new Types.ObjectId(),
    );

    // Sin email no hay nada que chequear por duplicado — ni siquiera se
    // llama a `findOne` (el índice único de Mongo es `sparse`, así que
    // varios usuarios sin email conviven sin chocar, ver `user.schema.ts`).
    expect(userModelMock.findOne).not.toHaveBeenCalled();
    const createArgs = userModelMock.create.mock.calls[0][0];
    expect(createArgs.email).toBeUndefined();
  });

  describe('update', () => {
    interface MockUser {
      _id: Types.ObjectId;
      email?: string;
      nombre: string;
      save: jest.Mock;
    }

    function mockUser(overrides: Partial<MockUser> = {}): MockUser {
      const user: MockUser = {
        _id: new Types.ObjectId(),
        email: undefined,
        nombre: 'Nadia Folgar',
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides,
      };
      userModelMock.findById.mockReturnValue({
        populate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(user) }),
      });
      return user;
    }

    it('permite completarle el email a un usuario que no tenía (caso "Personal" sin email)', async () => {
      const user = mockUser();
      userModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      const updated = await service.update(user._id.toString(), {
        email: 'Nadia@Folgar.com',
      });

      expect(updated.email).toBe('nadia@folgar.com');
      expect(user.save).toHaveBeenCalled();
    });

    it('rechaza el email nuevo si ya lo tiene otro usuario (antes esta ruta no lo chequeaba)', async () => {
      const user = mockUser();
      userModelMock.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ email: 'tomado@folgar.com' }),
      });

      await expect(
        service.update(user._id.toString(), { email: 'tomado@folgar.com' } as any),
      ).rejects.toThrow(ConflictException);
      expect(user.save).not.toHaveBeenCalled();
    });

    it('no toca el email si no viene en el body — undefined sigue significando "no tocar"', async () => {
      const user = mockUser({ email: 'ya@tengo.com' });

      await service.update(user._id.toString(), { nombre: 'Nuevo Nombre' });

      expect(user.email).toBe('ya@tengo.com');
      expect(user.nombre).toBe('Nuevo Nombre');
      expect(userModelMock.findOne).not.toHaveBeenCalled();
    });
  });

  describe('generarCredencialesInstitucionales', () => {
    function mockUserSinEmail(overrides: Partial<Record<string, unknown>> = {}) {
      const user = {
        _id: new Types.ObjectId(),
        email: undefined,
        nombre: 'Nadia Folgar',
        passwordHash: 'hash-viejo',
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides,
      };
      userModelMock.findById.mockReturnValue({
        populate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(user) }),
      });
      return user;
    }

    it('arma el email institucional a partir del nombre, sin tildes ni espacios', async () => {
      const user = mockUserSinEmail();
      userModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      const { user: actualizado, password } = await service.generarCredencialesInstitucionales(
        user._id.toString(),
      );

      expect(actualizado.email).toBe('nadia.folgar@folgar.com.ar');
      // También queda en `emailInstitucional` (además de `email`) — así el
      // Frontend puede distinguir "esto es un login institucional
      // autogenerado" de un email personal real cargado más adelante.
      expect((actualizado as any).emailInstitucional).toBe('nadia.folgar@folgar.com.ar');
      expect(typeof password).toBe('string');
      expect(password.length).toBeGreaterThanOrEqual(12);
      expect(user.save).toHaveBeenCalled();
      expect(actualizado.credencialesGeneradas).toBe(true);
      await expect(argon2.verify(user.passwordHash, password)).resolves.toBe(true);
    });

    it('le suma un sufijo numérico si ese email ya está tomado por otro integrante', async () => {
      const user = mockUserSinEmail();
      userModelMock.findOne
        .mockReturnValueOnce({
          exec: jest.fn().mockResolvedValue({ email: 'nadia.folgar@folgar.com.ar' }),
        })
        .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(null) });

      const { user: actualizado } = await service.generarCredencialesInstitucionales(
        user._id.toString(),
      );

      expect(actualizado.email).toBe('nadia.folgar2@folgar.com.ar');
    });

    it('rechaza generarlo si el integrante ya tiene un email cargado', async () => {
      const user = mockUserSinEmail({ email: 'ya@folgar.com.ar' });

      await expect(service.generarCredencialesInstitucionales(user._id.toString())).rejects.toThrow(
        ConflictException,
      );
      expect(user.save).not.toHaveBeenCalled();
    });
  });

  describe('generarCredencialesDeAcceso', () => {
    interface MockUserConEmail {
      _id: Types.ObjectId;
      email?: string;
      emailInstitucional?: string;
      nombre: string;
      passwordHash: string;
      save: jest.Mock;
    }

    function mockUserConEmail(overrides: Partial<MockUserConEmail> = {}): MockUserConEmail {
      const user: MockUserConEmail = {
        _id: new Types.ObjectId(),
        email: 'daiana@folgar.com.ar',
        nombre: 'Daiana',
        passwordHash: 'hash-viejo',
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides,
      };
      userModelMock.findById.mockReturnValue({
        populate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(user) }),
      });
      return user;
    }

    it('genera un login institucional aparte, sin pisar el email real, y manda el mail al email real', async () => {
      const user = mockUserConEmail();
      userModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      const { password, emailInstitucional, emailEnviado } =
        await service.generarCredencialesDeAcceso(user._id.toString());

      expect(emailInstitucional).toBe('daiana@folgar.com.ar');
      // El email real NUNCA se toca — sigue siendo el mismo que antes de generar el institucional.
      expect(user.email).toBe('daiana@folgar.com.ar');
      expect(user.emailInstitucional).toBe(emailInstitucional);
      expect(typeof password).toBe('string');
      expect(password.length).toBeGreaterThanOrEqual(12);
      expect(user.save).toHaveBeenCalled();
      expect((user as any).credencialesGeneradas).toBe(true);
      await expect(argon2.verify(user.passwordHash, password)).resolves.toBe(true);
      expect(mailServiceMock.enviarCredenciales).toHaveBeenCalledWith({
        to: 'daiana@folgar.com.ar',
        usuario: emailInstitucional,
        nombre: 'Daiana',
        password,
        esCliente: false,
      });
      expect(emailEnviado).toBe(true);
    });

    it('le suma un sufijo numérico si ese login institucional ya está tomado (por email real o institucional de otro)', async () => {
      const user = mockUserConEmail();
      userModelMock.findOne
        .mockReturnValueOnce({
          exec: jest.fn().mockResolvedValue({ email: 'daiana@folgar.com.ar' }),
        })
        .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(null) });

      const { emailInstitucional } = await service.generarCredencialesDeAcceso(user._id.toString());

      expect(emailInstitucional).toBe('daiana2@folgar.com.ar');
    });

    it('rechaza generarlas si el integrante todavía no tiene un email cargado', async () => {
      const user = mockUserConEmail({ email: undefined });

      await expect(service.generarCredencialesDeAcceso(user._id.toString())).rejects.toThrow(
        BadRequestException,
      );
      expect(user.save).not.toHaveBeenCalled();
      expect(mailServiceMock.enviarCredenciales).not.toHaveBeenCalled();
    });
  });

  describe('regenerarPassword ("Cambiar contraseña" — resetea, nunca recupera la original)', () => {
    function mockUserConCredenciales(overrides: Partial<Record<string, unknown>> = {}) {
      const user = {
        _id: new Types.ObjectId(),
        email: 'daiana@folgar.com.ar',
        emailInstitucional: null,
        nombre: 'Daiana',
        passwordHash: 'hash-viejo',
        credencialesGeneradas: true,
        debeCambiarPassword: false,
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides,
      };
      userModelMock.findById.mockReturnValue({
        populate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(user) }),
      });
      return user;
    }

    it('rechaza si el integrante todavía no tiene ninguna cuenta creada', async () => {
      const user = mockUserConCredenciales({ credencialesGeneradas: false });

      await expect(service.regenerarPassword(user._id.toString())).rejects.toThrow(
        BadRequestException,
      );
      expect(user.save).not.toHaveBeenCalled();
    });

    it('genera una contraseña nueva sin tocar el email de login, marca debeCambiarPassword y avisa por mail', async () => {
      const user = mockUserConCredenciales();
      const passwordHashViejo = user.passwordHash;

      const { password, emailEnviado } = await service.regenerarPassword(user._id.toString());

      expect(user.email).toBe('daiana@folgar.com.ar');
      expect(user.save).toHaveBeenCalled();
      expect(user.passwordHash).not.toBe(passwordHashViejo);
      expect(user.debeCambiarPassword).toBe(true);
      await expect(argon2.verify(user.passwordHash, password)).resolves.toBe(true);
      expect(mailServiceMock.enviarCredenciales).toHaveBeenCalledWith({
        to: 'daiana@folgar.com.ar',
        usuario: 'daiana@folgar.com.ar',
        nombre: 'Daiana',
        password,
        esCliente: false,
      });
      expect(emailEnviado).toBe(true);
    });

    it('usa la contraseña manual en vez de generar una, si se la mandan', async () => {
      const user = mockUserConCredenciales();

      const { password } = await service.regenerarPassword(
        user._id.toString(),
        'unaClaveManual123',
      );

      expect(password).toBe('unaClaveManual123');
      await expect(argon2.verify(user.passwordHash, 'unaClaveManual123')).resolves.toBe(true);
    });

    it('no manda mail si el único email que tiene es el institucional (nadie lee esa casilla)', async () => {
      const user = mockUserConCredenciales({
        email: 'nadia.folgar@folgar.com.ar',
        emailInstitucional: 'nadia.folgar@folgar.com.ar',
      });

      const { emailEnviado } = await service.regenerarPassword(user._id.toString());

      expect(mailServiceMock.enviarCredenciales).not.toHaveBeenCalled();
      expect(emailEnviado).toBe(false);
    });
  });

  describe('updateOwnProfile', () => {
    function mockSelf(overrides: Partial<Record<string, unknown>> = {}) {
      const self = {
        _id: new Types.ObjectId(),
        email: 'yo@folgar.com',
        nombre: 'Yo',
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides,
      };
      userModelMock.findById.mockReturnValue({
        populate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(self) }),
      });
      return self;
    }

    it('rechaza cambiar el email a uno ya usado por otro usuario', async () => {
      const self = mockSelf();
      userModelMock.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ email: 'tomado@folgar.com' }),
      });

      await expect(
        service.updateOwnProfile(self._id.toString(), { email: 'tomado@folgar.com' }),
      ).rejects.toThrow(ConflictException);
      expect(self.save).not.toHaveBeenCalled();
    });

    it('actualiza nombre y datos de contacto', async () => {
      const self = mockSelf();

      const updated = await service.updateOwnProfile(self._id.toString(), {
        nombre: 'Nuevo Nombre',
        telefono: '+54 9 291 123-4567',
        pais: 'Argentina',
        genero: 'femenino',
      });

      expect(updated.nombre).toBe('Nuevo Nombre');
      expect(updated.telefono).toBe('+54 9 291 123-4567');
      expect(updated.pais).toBe('Argentina');
      expect(updated.genero).toBe('femenino');
      expect(self.save).toHaveBeenCalled();
    });
  });

  describe('changeOwnPassword', () => {
    it('rechaza si la contraseña actual no coincide', async () => {
      const passwordHash = await argon2.hash('correcta123');
      const self = {
        _id: new Types.ObjectId(),
        passwordHash,
        save: jest.fn(),
      };
      userModelMock.findById.mockReturnValue({
        populate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(self) }),
      });

      await expect(
        service.changeOwnPassword(self._id.toString(), {
          currentPassword: 'incorrecta',
          newPassword: 'nuevaClave123',
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(self.save).not.toHaveBeenCalled();
    });

    it('hashea y guarda la nueva contraseña cuando la actual es correcta, y limpia debeCambiarPassword', async () => {
      const passwordHash = await argon2.hash('correcta123');
      const self = {
        _id: new Types.ObjectId(),
        passwordHash,
        debeCambiarPassword: true,
        save: jest.fn().mockResolvedValue(undefined),
      };
      userModelMock.findById.mockReturnValue({
        populate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(self) }),
      });

      await service.changeOwnPassword(self._id.toString(), {
        currentPassword: 'correcta123',
        newPassword: 'nuevaClave123',
      });

      expect(self.save).toHaveBeenCalled();
      expect(self.passwordHash).not.toBe(passwordHash);
      expect(self.debeCambiarPassword).toBe(false);
      await expect(argon2.verify(self.passwordHash, 'nuevaClave123')).resolves.toBe(true);
    });
  });

  describe('toProfileResponse', () => {
    it('arma el data URL del avatar cuando hay foto cargada', () => {
      const profile = service.toProfileResponse({
        _id: new Types.ObjectId(),
        email: 'yo@folgar.com',
        nombre: 'Yo',
        avatarContentType: 'image/png',
        avatarBase64: 'AAAA',
      } as any);

      expect(profile.avatarDataUrl).toBe('data:image/png;base64,AAAA');
    });

    it('devuelve avatarDataUrl null cuando no hay foto cargada', () => {
      const profile = service.toProfileResponse({
        _id: new Types.ObjectId(),
        email: 'yo@folgar.com',
        nombre: 'Yo',
        genero: 'femenino',
      } as any);

      expect(profile.avatarDataUrl).toBeNull();
      expect(profile.genero).toBe('femenino');
    });
  });

  describe('toSummary', () => {
    it('nunca incluye passwordHash, y mapea los roles poblados por nombre', () => {
      const roleId = new Types.ObjectId();
      const summary = service.toSummary({
        _id: new Types.ObjectId(),
        email: 'contadora@folgar.com',
        nombre: 'Una Contadora',
        passwordHash: 'hash-secreto-no-debería-salir',
        telefono: '+54 9 291 555-1234',
        regimenFiscal: 'monotributo',
        roleIds: [{ _id: roleId, nombre: 'contador' }],
        activo: true,
        credencialesGeneradas: true,
      } as any);

      expect(summary).not.toHaveProperty('passwordHash');
      expect(summary.roles).toEqual([{ _id: roleId.toString(), nombre: 'contador' }]);
      expect(summary.telefono).toBe('+54 9 291 555-1234');
      expect(summary.regimenFiscal).toBe('monotributo');
      expect(summary.tieneCredenciales).toBe(true);
    });

    it('no revienta si roleIds no vino poblado (queda con nombre vacío)', () => {
      const roleId = new Types.ObjectId();
      const summary = service.toSummary({
        _id: new Types.ObjectId(),
        email: 'sin-poblar@folgar.com',
        nombre: 'Sin Poblar',
        roleIds: [roleId],
        activo: true,
      } as any);

      expect(summary.roles).toEqual([{ _id: roleId.toString(), nombre: '' }]);
    });

    it('expone emailInstitucional aparte de email, sin mezclarlos', () => {
      const summary = service.toSummary({
        _id: new Types.ObjectId(),
        email: 'daiana@gmail.com',
        emailInstitucional: 'daiana.gencarelli@folgar.com.ar',
        nombre: 'Daiana',
        roleIds: [],
        activo: true,
      } as any);

      expect(summary.email).toBe('daiana@gmail.com');
      expect(summary.emailInstitucional).toBe('daiana.gencarelli@folgar.com.ar');
    });

    it('considera "con credenciales" a una cuenta con emailInstitucional aunque credencialesGeneradas no esté seteado (cuentas de antes de este campo)', () => {
      const summary = service.toSummary({
        _id: new Types.ObjectId(),
        email: 'daiana@gmail.com',
        emailInstitucional: 'daiana.gencarelli@folgar.com.ar',
        nombre: 'Daiana',
        roleIds: [],
        activo: true,
        // Sin `credencialesGeneradas` — mismo estado que tenían los usuarios
        // reales creados antes de agregar ese campo.
      } as any);

      expect(summary.tieneCredenciales).toBe(true);
    });
  });

  describe('findByEmail', () => {
    it('matchea tanto por el email real como por el institucional', async () => {
      userModelMock.findOne.mockReturnValue({
        populate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      });

      await service.findByEmail('Daiana.Gencarelli@Folgar.com.ar');

      expect(userModelMock.findOne).toHaveBeenCalledWith({
        $or: [
          { email: 'daiana.gencarelli@folgar.com.ar' },
          { emailInstitucional: 'daiana.gencarelli@folgar.com.ar' },
        ],
      });
    });
  });
});
