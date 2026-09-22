import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { UsersService } from '../users/users.service';
import { UserDocument } from '../users/schemas/user.schema';
import { AuthenticatedUser, UserRole } from '../common/types/authenticated-user';
import { Role } from '../roles/schemas/role.schema';
import { esEmailInstitucional } from '../common/utils/email-institucional.util';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface RefreshPayload {
  sub: string;
}

export type SocialProvider = 'google' | 'linkedin' | 'apple';

interface SocialProfile {
  email: string;
  emailVerified: boolean;
}

interface OAuthProviderConfig {
  clientId?: string;
  clientSecret?: string;
  callbackUrl: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Login por contraseña — históricamente exigía un email institucional
   * (`@folgar.com.ar`) acá, porque tanto "Personal" (login institucional)
   * como el portal de "Cliente" (login institucional armado desde el
   * nombre) solo tenían contraseña bajo ese dominio. Pedido explícito del
   * usuario: el portal de Cliente pasa a loguearse con el email REAL del
   * cliente (`ClientesService.crearUsuarioPortal` ya no arma ningún
   * `@folgar.com.ar`), así que ese gate quedaría bloqueando a cualquier
   * cliente real — se saca. La seguridad real sigue siendo `findByEmail` +
   * el hash de `argon2.verify` de abajo, no el dominio del email.
   */
  async validateUser(email: string, password: string): Promise<UserDocument> {
    const user = await this.usersService.findByEmail(email);
    if (!user || !this.isActiveUser(user)) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    return user;
  }

  buildUserContext(user: UserDocument): AuthenticatedUser {
    // `User.email` es opcional en el schema (ver la nota ahí: un integrante de
    // "Personal" se puede crear sin email todavía) pero acá siempre debería
    // venir completo — a este punto ya se autenticó por password o por login
    // social, y las dos vías (`validateUser`/`loginWithSocialCode`) buscan al
    // usuario justamente por email, así que uno sin email nunca llega hasta
    // acá. Si algún día llegara, mejor un error claro que un token roto.
    if (!user.email) {
      throw new UnauthorizedException('El usuario no tiene un email asociado');
    }

    const roles = (user.roleIds as unknown as Role[]).filter(
      (role): role is Role => typeof role === 'object' && role !== null && 'nombre' in role,
    );
    // Permisos heredados de los roles, con las excepciones puntuales del
    // usuario encima (`permisosExtra`) y descontando las suyas (`permisosDenegados`,
    // que siempre gana por sobre lo que dé el rol) — ver el comentario en
    // `user.schema.ts`.
    const rolePermissions = roles.flatMap((role) => role.permisos);
    const permisosDenegados = new Set(user.permisosDenegados ?? []);
    const permissions = Array.from(
      new Set([...rolePermissions, ...(user.permisosExtra ?? [])]),
    ).filter((permission) => !permisosDenegados.has(permission));

    return {
      userId: user._id.toString(),
      email: user.email,
      roles: roles.map((role) => role.nombre) as UserRole[],
      permissions,
      estudioId: user.estudioId.toString(),
      clienteId: user.clienteId?.toString(),
      debeCambiarPassword: user.debeCambiarPassword ?? false,
    };
  }

  login(user: UserDocument): TokenPair {
    return this.issueTokens(this.buildUserContext(user));
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: RefreshPayload;
    try {
      payload = this.jwtService.verify<RefreshPayload>(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Refresh token inválido o vencido');
    }

    const user = await this.usersService.findOne(payload.sub);
    if (!this.isActiveUser(user)) {
      throw new UnauthorizedException('Usuario inactivo');
    }

    return this.issueTokens(this.buildUserContext(user));
  }

  buildSocialAuthorizationUrl(provider: SocialProvider, returnTo?: string): string {
    const state = Buffer.from(
      JSON.stringify({ returnTo: returnTo || this.frontendCallbackUrl }),
    ).toString('base64url');

    if (provider === 'google') {
      const config = this.getOAuthConfig('GOOGLE');
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.callbackUrl,
        response_type: 'code',
        scope: 'openid email profile',
        prompt: 'select_account',
        state,
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    if (provider === 'linkedin') {
      const config = this.getOAuthConfig('LINKEDIN');
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.callbackUrl,
        response_type: 'code',
        scope: 'openid profile email',
        state,
      });
      return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
    }

    const config = this.getOAuthConfig('APPLE');
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      response_type: 'code',
      response_mode: 'query',
      scope: 'name email',
      state,
    });
    return `https://appleid.apple.com/auth/authorize?${params.toString()}`;
  }

  async loginWithSocialCode(provider: SocialProvider, code: string): Promise<TokenPair> {
    const profile = await this.fetchSocialProfile(provider, code);
    if (!profile.emailVerified) {
      throw new UnauthorizedException('El proveedor no confirmó el email de la cuenta');
    }

    if (!esEmailInstitucional(profile.email)) {
      throw new UnauthorizedException('No existe un usuario activo asociado a ese email');
    }

    const user = await this.usersService.findByEmail(profile.email);
    if (!user || !this.isActiveUser(user)) {
      throw new UnauthorizedException('No existe un usuario activo asociado a ese email');
    }

    return this.login(user);
  }

  private isActiveUser(user: UserDocument): boolean {
    return user.activo !== false;
  }

  resolveSocialReturnTo(state?: string): string {
    if (!state) return this.frontendCallbackUrl;

    try {
      const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as {
        returnTo?: string;
      };
      return parsed.returnTo || this.frontendCallbackUrl;
    } catch {
      return this.frontendCallbackUrl;
    }
  }

  private issueTokens(context: AuthenticatedUser): TokenPair {
    const accessToken = this.jwtService.sign(context as unknown as Record<string, unknown>, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: this.configService.get<string>('JWT_EXPIRES_IN') as never,
    });

    const refreshToken = this.jwtService.sign(
      { sub: context.userId },
      {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') as never,
      },
    );

    return { accessToken, refreshToken };
  }

  private get frontendCallbackUrl(): string {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:5173');
    return `${frontendUrl.replace(/\/$/, '')}/auth/callback`;
  }

  private getOAuthConfig(provider: 'GOOGLE' | 'LINKEDIN' | 'APPLE'): Required<OAuthProviderConfig> {
    const clientId = this.configService.get<string>(`${provider}_OAUTH_CLIENT_ID`);
    const clientSecret =
      provider === 'APPLE'
        ? this.getAppleClientSecret()
        : this.configService.get<string>(`${provider}_OAUTH_CLIENT_SECRET`);
    const callbackUrl =
      this.configService.get<string>(`${provider}_OAUTH_CALLBACK_URL`) ||
      `http://localhost:${this.configService.get<number>('PORT', 3000)}/${this.configService.get<string>('API_PREFIX', 'api/v1')}/auth/${provider.toLowerCase()}/callback`;

    if (!clientId || !clientSecret) {
      throw new ServiceUnavailableException(
        `OAuth ${provider.toLowerCase()} no está configurado en el Backend`,
      );
    }

    return { clientId, clientSecret, callbackUrl };
  }

  private getAppleClientSecret(): string | undefined {
    const configuredSecret = this.configService.get<string>('APPLE_OAUTH_CLIENT_SECRET');
    if (configuredSecret) return configuredSecret;

    const teamId = this.configService.get<string>('APPLE_OAUTH_TEAM_ID');
    const keyId = this.configService.get<string>('APPLE_OAUTH_KEY_ID');
    const privateKey = this.configService
      .get<string>('APPLE_OAUTH_PRIVATE_KEY')
      ?.replace(/\\n/g, '\n');
    const clientId = this.configService.get<string>('APPLE_OAUTH_CLIENT_ID');
    if (!teamId || !keyId || !privateKey || !clientId) return undefined;

    return this.jwtService.sign(
      {
        iss: teamId,
        aud: 'https://appleid.apple.com',
        sub: clientId,
      },
      {
        algorithm: 'ES256',
        privateKey,
        keyid: keyId,
        expiresIn: '5m',
      } as never,
    );
  }

  private async fetchSocialProfile(provider: SocialProvider, code: string): Promise<SocialProfile> {
    if (provider === 'google') return this.fetchGoogleProfile(code);
    if (provider === 'linkedin') return this.fetchLinkedInProfile(code);
    return this.fetchAppleProfile(code);
  }

  private async fetchGoogleProfile(code: string): Promise<SocialProfile> {
    const config = this.getOAuthConfig('GOOGLE');
    const token = await this.postToken('https://oauth2.googleapis.com/token', {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.callbackUrl,
      grant_type: 'authorization_code',
    });

    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const profile = (await response.json()) as { email?: string; email_verified?: boolean };
    if (!response.ok || !profile.email) {
      throw new UnauthorizedException('No se pudo obtener el perfil de Google');
    }
    return { email: profile.email, emailVerified: profile.email_verified === true };
  }

  private async fetchLinkedInProfile(code: string): Promise<SocialProfile> {
    const config = this.getOAuthConfig('LINKEDIN');
    const token = await this.postToken('https://www.linkedin.com/oauth/v2/accessToken', {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.callbackUrl,
      grant_type: 'authorization_code',
    });

    const response = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const profile = (await response.json()) as { email?: string; email_verified?: boolean };
    if (!response.ok || !profile.email) {
      throw new UnauthorizedException('No se pudo obtener el perfil de LinkedIn');
    }
    return { email: profile.email, emailVerified: profile.email_verified !== false };
  }

  private async fetchAppleProfile(code: string): Promise<SocialProfile> {
    const config = this.getOAuthConfig('APPLE');
    const token = await this.postToken('https://appleid.apple.com/auth/token', {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.callbackUrl,
      grant_type: 'authorization_code',
    });

    const idToken = token.id_token;
    if (!idToken) {
      throw new UnauthorizedException('Apple no devolvió identidad de usuario');
    }

    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'),
    ) as {
      email?: string;
      email_verified?: boolean | string;
    };
    if (!payload.email) {
      throw new UnauthorizedException('No se pudo obtener el email de Apple');
    }
    return {
      email: payload.email,
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    };
  }

  private async postToken(
    url: string,
    params: Record<string, string>,
  ): Promise<Record<string, string>> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const data = (await response.json()) as Record<string, string>;
    if (!response.ok || !data.access_token) {
      throw new UnauthorizedException('No se pudo completar el intercambio OAuth');
    }
    return data;
  }
}
