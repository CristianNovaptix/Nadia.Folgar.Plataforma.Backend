import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { Types } from 'mongoose';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

describe('AuthService', () => {
  let service: AuthService;
  const configValues: Record<string, string | number> = {
    API_PREFIX: 'api/v1',
    FRONTEND_URL: 'http://localhost:5173',
    GOOGLE_OAUTH_CLIENT_ID: 'google-client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret',
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
    JWT_REFRESH_SECRET: 'test-refresh-secret',
    JWT_SECRET: 'test-secret',
    PORT: 3000,
  };
  const usersServiceMock = {
    findByEmail: jest.fn(),
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersServiceMock },
        JwtService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: string | number) => configValues[key] ?? fallback,
          },
        },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  it('rechaza credenciales con password incorrecto', async () => {
    const passwordHash = await argon2.hash('correcta123');
    usersServiceMock.findByEmail.mockResolvedValue({ activo: true, passwordHash });

    await expect(service.validateUser('contadora@folgar.com.ar', 'incorrecta')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza usuarios inactivos aunque la password sea correcta', async () => {
    const passwordHash = await argon2.hash('correcta123');
    usersServiceMock.findByEmail.mockResolvedValue({ activo: false, passwordHash });

    await expect(service.validateUser('contadora@folgar.com.ar', 'correcta123')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('acepta usuarios viejos sin campo activo cuando la password es correcta', async () => {
    const passwordHash = await argon2.hash('correcta123');
    const user = { passwordHash };
    usersServiceMock.findByEmail.mockResolvedValue(user);

    await expect(service.validateUser('contadora@folgar.com.ar', 'correcta123')).resolves.toBe(
      user,
    );
  });

  it('acepta login por password con un email real, no institucional (portal de Cliente)', async () => {
    // Pedido explícito del usuario: el portal de Cliente se loguea con el
    // email real del cliente, no con uno `@folgar.com.ar` — el gate que
    // antes rechazaba cualquier email no institucional se sacó, ver el
    // comentario en `AuthService.validateUser`.
    const passwordHash = await argon2.hash('correcta123');
    const user = { activo: true, passwordHash };
    usersServiceMock.findByEmail.mockResolvedValue(user);

    await expect(service.validateUser('cliente@gmail.com', 'correcta123')).resolves.toBe(user);
    expect(usersServiceMock.findByEmail).toHaveBeenCalledWith('cliente@gmail.com');
  });

  it('rechaza login social con un email que no sea institucional', async () => {
    jest.spyOn(service as any, 'fetchSocialProfile').mockResolvedValue({
      email: 'contadora@gmail.com',
      emailVerified: true,
    });

    await expect(service.loginWithSocialCode('google', 'code')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(usersServiceMock.findByEmail).not.toHaveBeenCalled();
  });

  it('buildUserContext calcula permisos como unión de los roles del usuario', () => {
    const user = {
      _id: new Types.ObjectId(),
      email: 'a@b.com',
      estudioId: new Types.ObjectId(),
      clienteId: undefined,
      roleIds: [
        { nombre: 'contador', permisos: ['clientes.read', 'clientes.write'] },
        { nombre: 'admin', permisos: ['clientes.write', 'users.read'] },
      ],
    } as any;

    const context = service.buildUserContext(user);

    expect(context.roles).toEqual(['contador', 'admin']);
    expect(context.permissions.sort()).toEqual(
      ['clientes.read', 'clientes.write', 'users.read'].sort(),
    );
  });

  it('buildUserContext suma permisosExtra y resta permisosDenegados por sobre los del rol', () => {
    const user = {
      _id: new Types.ObjectId(),
      email: 'a@b.com',
      estudioId: new Types.ObjectId(),
      clienteId: undefined,
      roleIds: [{ nombre: 'contador', permisos: ['clientes.read', 'clientes.write'] }],
      permisosExtra: ['users.read'],
      permisosDenegados: ['clientes.write'],
    } as any;

    const context = service.buildUserContext(user);

    expect(context.permissions.sort()).toEqual(['clientes.read', 'users.read'].sort());
  });

  it('buildUserContext propaga debeCambiarPassword (true cuando un admin reseteó la contraseña)', () => {
    const baseUser = {
      _id: new Types.ObjectId(),
      email: 'a@b.com',
      estudioId: new Types.ObjectId(),
      clienteId: undefined,
      roleIds: [{ nombre: 'contador', permisos: [] }],
    };

    expect(
      service.buildUserContext({ ...baseUser, debeCambiarPassword: true } as any)
        .debeCambiarPassword,
    ).toBe(true);
    expect(service.buildUserContext(baseUser as any).debeCambiarPassword).toBe(false);
  });

  it('arma la URL de inicio OAuth de Google con callback y returnTo', () => {
    const url = new URL(
      service.buildSocialAuthorizationUrl('google', 'http://localhost:5173/auth/callback'),
    );

    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('google-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/v1/auth/google/callback',
    );
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBeTruthy();
  });
});
