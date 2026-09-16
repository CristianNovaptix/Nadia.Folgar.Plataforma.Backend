import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';

describe('MailService', () => {
  function configMock(vars: Record<string, string> = {}): ConfigService {
    return { get: (key: string) => vars[key] } as unknown as ConfigService;
  }

  it('sin SMTP_HOST/SMTP_USER/SMTP_PASS configurados, no envía nada y devuelve false', async () => {
    const service = new MailService(configMock());

    const enviado = await service.enviarTexto('a@b.com', 'Asunto', 'Cuerpo');

    expect(enviado).toBe(false);
  });

  it('arma el texto de "credenciales de acceso" según sea Personal o Cliente', async () => {
    const service = new MailService(configMock());
    const spy = jest.spyOn(service, 'enviarTexto');

    await service.enviarCredenciales({
      to: 'cliente@ejemplo.com',
      usuario: 'cliente@ejemplo.com',
      nombre: 'Cliente Test',
      password: 'abc123',
      esCliente: true,
    });

    expect(spy).toHaveBeenCalledWith(
      'cliente@ejemplo.com',
      expect.stringContaining('credenciales'),
      expect.stringContaining('portal de clientes'),
    );
  });

  it('el texto usa "usuario" (login) aunque sea distinto de "to" (a dónde se manda)', async () => {
    const service = new MailService(configMock());
    const spy = jest.spyOn(service, 'enviarTexto');

    await service.enviarCredenciales({
      to: 'contacto-real@ejemplo.com',
      usuario: 'cliente.test@folgar.com.ar',
      nombre: 'Cliente Test',
      password: 'abc123',
      esCliente: true,
    });

    expect(spy).toHaveBeenCalledWith(
      'contacto-real@ejemplo.com',
      expect.any(String),
      expect.stringContaining('Usuario: cliente.test@folgar.com.ar'),
    );
  });
});
