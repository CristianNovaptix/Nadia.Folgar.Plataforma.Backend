import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SecretCipherService } from '../common/crypto/secret-cipher.service';
import { Reunion, ReunionDocument } from '../inicio/schemas/reunion.schema';
import { GoogleCalendarCuenta } from './schemas/google-calendar-cuenta.schema';

const SCOPES = 'openid email https://www.googleapis.com/auth/calendar.events';
const ZONA_HORARIA = 'America/Argentina/Buenos_Aires';
/** `Reunion` no tiene hora de fin: el evento de Google dura una hora. */
const DURACION_MS = 60 * 60 * 1000;
const EVENTOS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export interface EstadoGoogleCalendar {
  configurado: boolean;
  conectado: boolean;
  email?: string;
}

/**
 * Sincronización de reuniones con el Google Calendar de cada usuario. Cada uno
 * conecta su propia cuenta (OAuth con `access_type=offline`), y al crear,
 * editar, mandar a la papelera o eliminar una reunión se replica en el
 * calendario de su creador y de sus miembros que tengan la cuenta conectada.
 * Nunca rompe el guardado de la reunión: si Google falla, solo se loguea.
 * Usa las mismas credenciales OAuth de Google que el login social.
 */
@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);

  constructor(
    @InjectModel(GoogleCalendarCuenta.name)
    private readonly cuentaModel: Model<GoogleCalendarCuenta>,
    @InjectModel(Reunion.name) private readonly reunionModel: Model<Reunion>,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly cipher: SecretCipherService,
  ) {}

  private get oauth() {
    const clientId = this.configService.get<string>('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GOOGLE_OAUTH_CLIENT_SECRET');
    const callbackUrl =
      this.configService.get<string>('GOOGLE_CALENDAR_CALLBACK_URL') ||
      `http://localhost:${this.configService.get<number>('PORT', 3000)}/${this.configService.get<string>('API_PREFIX', 'api/v1')}/google-calendar/callback`;
    return clientId && clientSecret ? { clientId, clientSecret, callbackUrl } : null;
  }

  private get frontendUrl(): string {
    return this.configService.get<string>('FRONTEND_URL', 'http://localhost:5173').replace(/\/$/, '');
  }

  async estado(userId: string): Promise<EstadoGoogleCalendar> {
    const cuenta = await this.cuentaModel.findOne({ userId: new Types.ObjectId(userId) }).exec();
    return { configurado: Boolean(this.oauth), conectado: Boolean(cuenta), email: cuenta?.email };
  }

  urlConexion(userId: string, estudioId: string): string {
    const oauth = this.oauth;
    if (!oauth) {
      throw new ServiceUnavailableException('La conexión con Google no está configurada en el Backend');
    }
    const state = this.jwtService.sign(
      { sub: userId, estudioId, tipo: 'google-calendar' },
      { secret: this.configService.get<string>('JWT_SECRET'), expiresIn: '10m' },
    );
    const params = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: oauth.callbackUrl,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /** Callback de Google: guarda la cuenta y devuelve a dónde redirigir en el Frontend. */
  async completarConexion(code?: string, state?: string, error?: string): Promise<string> {
    const volver = (resultado: string, mensaje?: string) => {
      const params = new URLSearchParams({ googleCalendar: resultado });
      if (mensaje) params.set('mensaje', mensaje);
      return `${this.frontendUrl}/?${params.toString()}`;
    };
    if (error || !code || !state) return volver('error', 'No se completó la conexión con Google');

    let payload: { sub: string; estudioId: string; tipo: string };
    try {
      payload = this.jwtService.verify(state, { secret: this.configService.get<string>('JWT_SECRET') });
      if (payload.tipo !== 'google-calendar') throw new Error('state inválido');
    } catch {
      return volver('error', 'El pedido de conexión venció, probá de nuevo');
    }

    try {
      const oauth = this.oauth!;
      const token = await this.postToken({
        code,
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        redirect_uri: oauth.callbackUrl,
        grant_type: 'authorization_code',
      });
      if (!token.refresh_token) throw new Error('Google no devolvió un refresh token');

      const perfil = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      const { email } = (await perfil.json()) as { email?: string };

      const userId = new Types.ObjectId(payload.sub);
      await this.cuentaModel.findOneAndUpdate(
        { userId },
        { userId, email: email ?? 'Cuenta de Google', refreshTokenCifrado: this.cipher.encrypt(token.refresh_token) },
        { upsert: true },
      );
      await this.sincronizarProximas(payload.sub, payload.estudioId);
      return volver('conectado');
    } catch (err) {
      this.logger.warn(`No se pudo conectar Google Calendar: ${(err as Error).message}`);
      return volver('error', 'No se pudo conectar la cuenta de Google');
    }
  }

  /** Desconecta la cuenta y saca de su Google Calendar las reuniones que había creado la plataforma. */
  async desconectar(userId: string): Promise<void> {
    const uid = new Types.ObjectId(userId);
    const cuenta = await this.cuentaModel.findOne({ userId: uid }).exec();
    if (!cuenta) return;
    const reuniones = await this.reunionModel.find({ 'googleEventos.userId': uid }).exec();
    for (const reunion of reuniones) {
      const evento = reunion.googleEventos.find((e) => e.userId.equals(uid));
      if (evento) await this.borrarEvento(cuenta.refreshTokenCifrado, evento.eventId);
      reunion.googleEventos = reunion.googleEventos.filter((e) => !e.userId.equals(uid));
      await reunion.save();
    }
    const refreshToken = this.descifrar(cuenta.refreshTokenCifrado);
    if (refreshToken) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
        method: 'POST',
      }).catch(() => undefined);
    }
    await cuenta.deleteOne();
  }

  /**
   * Deja el Google Calendar de cada participante igual a la reunión: la crea o
   * actualiza, o la borra si está en la papelera o la persona dejó de participar.
   */
  async sincronizarReunion(reunionId: Types.ObjectId | string): Promise<void> {
    try {
      const reunion = await this.reunionModel
        .findById(reunionId)
        .populate('clienteId', 'nombre')
        .exec();
      if (!reunion) return;

      const participantes = reunion.enPapelera
        ? []
        : [reunion.creadoPor, ...(reunion.miembros ?? [])].filter(Boolean).map(String);
      const idsInvolucrados = new Set([
        ...participantes,
        ...reunion.googleEventos.map((e) => e.userId.toString()),
      ]);
      if (idsInvolucrados.size === 0) return;

      const cuentas = await this.cuentaModel
        .find({ userId: { $in: [...idsInvolucrados].map((id) => new Types.ObjectId(id)) } })
        .exec();
      const cuentaPorUsuario = new Map(cuentas.map((c) => [c.userId.toString(), c]));

      const eventos: Array<{ userId: Types.ObjectId; eventId: string }> = [];
      for (const userId of idsInvolucrados) {
        const cuenta = cuentaPorUsuario.get(userId);
        const actual = reunion.googleEventos.find((e) => e.userId.toString() === userId);
        if (!cuenta) continue;
        if (!participantes.includes(userId)) {
          if (actual) await this.borrarEvento(cuenta.refreshTokenCifrado, actual.eventId);
          continue;
        }
        const eventId = await this.guardarEvento(cuenta.refreshTokenCifrado, reunion, actual?.eventId);
        if (eventId) eventos.push({ userId: new Types.ObjectId(userId), eventId });
        else if (actual) eventos.push(actual);
      }
      await this.reunionModel.updateOne({ _id: reunion._id }, { $set: { googleEventos: eventos } }).exec();
    } catch (err) {
      this.logger.warn(`No se pudo sincronizar la reunión ${String(reunionId)}: ${(err as Error).message}`);
    }
  }

  /** Antes de eliminar una reunión para siempre: la saca de todos los Google Calendar. */
  async quitarReunion(reunion: ReunionDocument): Promise<void> {
    try {
      if (!reunion.googleEventos?.length) return;
      const cuentas = await this.cuentaModel
        .find({ userId: { $in: reunion.googleEventos.map((e) => e.userId) } })
        .exec();
      for (const evento of reunion.googleEventos) {
        const cuenta = cuentas.find((c) => c.userId.equals(evento.userId));
        if (cuenta) await this.borrarEvento(cuenta.refreshTokenCifrado, evento.eventId);
      }
    } catch (err) {
      this.logger.warn(`No se pudo quitar la reunión de Google Calendar: ${(err as Error).message}`);
    }
  }

  /** Al conectar la cuenta: sube las reuniones futuras que ya ve ese usuario. */
  private async sincronizarProximas(userId: string, estudioId: string): Promise<void> {
    const uid = new Types.ObjectId(userId);
    const reuniones = await this.reunionModel
      .find({
        estudioId: new Types.ObjectId(estudioId),
        fecha: { $gte: new Date() },
        enPapelera: { $ne: true },
        $or: [{ creadoPor: uid }, { miembros: uid }],
      })
      .select('_id')
      .exec();
    for (const r of reuniones) await this.sincronizarReunion(r._id);
  }

  private async guardarEvento(
    refreshTokenCifrado: string,
    reunion: ReunionDocument,
    eventId?: string,
  ): Promise<string | undefined> {
    const accessToken = await this.accessToken(refreshTokenCifrado);
    if (!accessToken) return undefined;

    const inicio = new Date(reunion.fecha);
    const cliente =
      reunion.clienteId && typeof reunion.clienteId === 'object' && 'nombre' in reunion.clienteId
        ? String((reunion.clienteId as unknown as { nombre: string }).nombre)
        : undefined;
    const descripcion = [
      cliente ? `Cliente: ${cliente}` : null,
      reunion.enlace ? `Link: ${reunion.enlace}` : null,
      'Agendada desde la plataforma del Estudio Nadia Folgar.',
    ]
      .filter(Boolean)
      .join('\n');
    const cuerpo = JSON.stringify({
      summary: reunion.titulo,
      description: descripcion,
      location: reunion.enlace || undefined,
      start: { dateTime: inicio.toISOString(), timeZone: ZONA_HORARIA },
      end: { dateTime: new Date(inicio.getTime() + DURACION_MS).toISOString(), timeZone: ZONA_HORARIA },
    });
    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

    if (eventId) {
      const res = await fetch(`${EVENTOS_URL}/${encodeURIComponent(eventId)}`, {
        method: 'PATCH',
        headers,
        body: cuerpo,
      });
      if (res.ok) return eventId;
      // Si lo borraron a mano en Google, se vuelve a crear.
      if (res.status !== 404 && res.status !== 410) {
        this.logger.warn(`Google Calendar respondió ${res.status} al actualizar un evento`);
        return eventId;
      }
    }
    const res = await fetch(EVENTOS_URL, { method: 'POST', headers, body: cuerpo });
    if (!res.ok) {
      this.logger.warn(`Google Calendar respondió ${res.status} al crear un evento`);
      return undefined;
    }
    const creado = (await res.json()) as { id: string };
    return creado.id;
  }

  private async borrarEvento(refreshTokenCifrado: string, eventId: string): Promise<void> {
    const accessToken = await this.accessToken(refreshTokenCifrado);
    if (!accessToken) return;
    await fetch(`${EVENTOS_URL}/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => undefined);
  }

  private async accessToken(refreshTokenCifrado: string): Promise<string | undefined> {
    const oauth = this.oauth;
    const refreshToken = this.descifrar(refreshTokenCifrado);
    if (!oauth || !refreshToken) return undefined;
    try {
      const token = await this.postToken({
        refresh_token: refreshToken,
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        grant_type: 'refresh_token',
      });
      return token.access_token;
    } catch (err) {
      this.logger.warn(`No se pudo renovar el acceso a Google Calendar: ${(err as Error).message}`);
      return undefined;
    }
  }

  private descifrar(valor: string): string | undefined {
    try {
      return this.cipher.decrypt(valor);
    } catch {
      return undefined;
    }
  }

  private async postToken(
    body: Record<string, string>,
  ): Promise<{ access_token: string; refresh_token?: string }> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; error?: string };
    if (!res.ok || !data.access_token) throw new Error(data.error ?? `Google respondió ${res.status}`);
    return { access_token: data.access_token, refresh_token: data.refresh_token };
  }
}
