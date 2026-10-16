import { Types } from 'mongoose';
import { GoogleCalendarService } from './google-calendar.service';

describe('GoogleCalendarService — cambios desde Google', () => {
  const creador = new Types.ObjectId();
  const invitado = new Types.ObjectId();

  function armar(reunion: Record<string, unknown> | null) {
    const cuentaModel = { updateOne: jest.fn(() => ({ exec: jest.fn() })) };
    const reunionModel = {
      findOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(reunion) })),
    };
    const config = {
      get: jest.fn(
        (k: string) => ({ GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' })[k],
      ),
    };
    const cipher = { decrypt: jest.fn(() => 'refresh') };
    const service = new GoogleCalendarService(
      cuentaModel as never,
      reunionModel as never,
      config as never,
      {} as never,
      cipher as never,
    );
    const sincronizarReunion = jest.spyOn(service, 'sincronizarReunion').mockResolvedValue();
    return { service, cuentaModel, sincronizarReunion };
  }

  function reunionBase() {
    return {
      _id: new Types.ObjectId(),
      titulo: 'Reunión',
      fecha: new Date('2026-10-20T13:00:00.000Z'),
      enlace: undefined as string | undefined,
      enPapelera: false,
      creadoPor: creador,
      miembros: [invitado],
      googleEventos: [
        { userId: creador, eventId: 'ev-creador' },
        { userId: invitado, eventId: 'ev-invitado' },
      ],
      save: jest.fn(),
    };
  }

  function mockFetch(items: unknown[]) {
    global.fetch = jest.fn((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            url.includes('oauth2')
              ? { access_token: 'token' }
              : { items, nextSyncToken: 'nuevo-token' },
          ),
      }),
    ) as never;
  }

  const cuenta = (userId: Types.ObjectId, syncToken?: string) =>
    ({ _id: new Types.ObjectId(), userId, refreshTokenCifrado: 'x', syncToken }) as never;

  it('la primera lectura solo guarda el syncToken, sin aplicar nada', async () => {
    const reunion = reunionBase();
    const { service, cuentaModel } = armar(reunion);
    mockFetch([{ id: 'ev-creador', summary: 'Otro título' }]);
    await service.sincronizarCuentaDesdeGoogle(cuenta(creador));
    expect(reunion.save).not.toHaveBeenCalled();
    expect(cuentaModel.updateOne).toHaveBeenCalledWith(expect.anything(), {
      $set: { syncToken: 'nuevo-token' },
    });
  });

  it('si se movió o renombró el evento, actualiza la reunión y la replica', async () => {
    const reunion = reunionBase();
    const { service, sincronizarReunion } = armar(reunion);
    mockFetch([
      {
        id: 'ev-invitado',
        summary: 'Reunión movida',
        start: { dateTime: '2026-10-21T15:00:00-03:00' },
      },
    ]);
    await service.sincronizarCuentaDesdeGoogle(cuenta(invitado, 'token-viejo'));
    expect(reunion.titulo).toBe('Reunión movida');
    expect(reunion.fecha.toISOString()).toBe('2026-10-21T18:00:00.000Z');
    expect(reunion.save).toHaveBeenCalled();
    expect(sincronizarReunion).toHaveBeenCalledWith(reunion._id);
  });

  it('sin cambios reales no guarda nada (evita el rebote de la propia sincronización)', async () => {
    const reunion = reunionBase();
    const { service } = armar(reunion);
    mockFetch([
      { id: 'ev-creador', summary: 'Reunión', start: { dateTime: '2026-10-20T13:00:00.000Z' } },
    ]);
    await service.sincronizarCuentaDesdeGoogle(cuenta(creador, 't'));
    expect(reunion.save).not.toHaveBeenCalled();
  });

  it('si quien la creó borra el evento, la reunión va a la papelera', async () => {
    const reunion = reunionBase();
    const { service } = armar(reunion);
    mockFetch([{ id: 'ev-creador', status: 'cancelled' }]);
    await service.sincronizarCuentaDesdeGoogle(cuenta(creador, 't'));
    expect(reunion.enPapelera).toBe(true);
    expect(reunion.save).toHaveBeenCalled();
  });

  it('si un invitado borra el evento, deja de ser miembro', async () => {
    const reunion = reunionBase();
    const { service } = armar(reunion);
    mockFetch([{ id: 'ev-invitado', status: 'cancelled' }]);
    await service.sincronizarCuentaDesdeGoogle(cuenta(invitado, 't'));
    expect(reunion.enPapelera).toBe(false);
    expect(reunion.miembros).toHaveLength(0);
    expect(reunion.googleEventos.map((e) => e.eventId)).toEqual(['ev-creador']);
  });
});
