import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Envío de mail transaccional real vía SMTP (nodemailer) — pedido explícito
 * del usuario para notificar por email las credenciales de acceso que se
 * generan al crear un integrante de "Personal" o el usuario de portal de un
 * "Cliente" (ver `UsersService.generarCredencialesDeAcceso` y
 * `ClientesService.crearUsuarioPortal`).
 *
 * Sin `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` cargados en el entorno (dev/CI, o
 * mientras el estudio no cargó la contraseña de aplicación real) el envío
 * queda en modo "solo log" — mismo criterio de fallback que ya usa
 * `AI_PROVIDER=stub` en Configuración → Integraciones: no rompe el flujo,
 * solo no manda nada de verdad hasta que se complete la configuración.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST');
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');
    this.from = this.config.get<string>('SMTP_FROM') || user || 'no-reply@folgar.com.ar';

    if (host && user && pass) {
      const port = Number(this.config.get<string>('SMTP_PORT') ?? 587);
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
    } else {
      this.transporter = null;
      this.logger.warn(
        'SMTP_HOST/SMTP_USER/SMTP_PASS no están configurados — los envíos de mail quedan solo logueados.',
      );
    }
  }

  /** Envío de texto libre — usado por las credenciales de acceso (ver más abajo). */
  async enviarTexto(to: string, subject: string, text: string): Promise<boolean> {
    if (!this.transporter) {
      this.logger.log(
        `[MAIL sin proveedor configurado] Envío simulado a "${to}" — asunto: ${subject}`,
      );
      return false;
    }

    try {
      await this.transporter.sendMail({ from: this.from, to, subject, text });
      return true;
    } catch (err) {
      this.logger.error(
        `No se pudo enviar el mail a "${to}" (asunto: ${subject})`,
        err instanceof Error ? err.stack : undefined,
      );
      return false;
    }
  }

  /**
   * "Tus credenciales de acceso" — misma mecánica para "Personal" (equipo
   * interno) y para el usuario de portal de un "Cliente": cambia solo el
   * texto según a qué entra (plataforma interna vs. portal de clientes), la
   * vista real que ve cada uno la sigue resolviendo el rol ya asignado.
   *
   * `to` (dónde se manda el mail) y `usuario` (el email con el que esa
   * persona va a loguearse) son cosas distintas y no necesariamente
   * coinciden — pedido explícito del usuario para el flujo de "Cliente"
   * (`ClientesService.crearUsuarioPortal`): el email real ya cargado en el
   * cliente NUNCA es el usuario de login, solo el buzón donde le llega el
   * aviso; el usuario de login siempre es uno institucional
   * `@folgar.com.ar`. Para "Personal" (`UsersService.generarCredencialesDeAcceso`)
   * ambos coinciden (usa el mismo email real ya cargado para las dos cosas).
   */
  async enviarCredenciales(params: {
    to: string;
    usuario: string;
    nombre: string;
    password: string;
    esCliente: boolean;
  }): Promise<boolean> {
    const { to, usuario, nombre, password, esCliente } = params;
    const frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173';
    const destino = esCliente ? 'al portal de clientes' : 'a la plataforma';
    const text =
      `Hola ${nombre},\n\n` +
      `Ya podés acceder ${destino} del Estudio Contable Nadia Folgar con estos datos:\n\n` +
      `Usuario: ${usuario}\n` +
      `Contraseña: ${password}\n\n` +
      `Ingresá en ${frontendUrl} y, por seguridad, cambiá la contraseña una vez que entres.\n`;

    return this.enviarTexto(to, 'Tus credenciales de acceso — Plataforma Folgar', text);
  }
}
