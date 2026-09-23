import { Injectable, Logger } from '@nestjs/common';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import {
  ARCA_DATOS_VACIOS,
  ArcaBloque,
  ArcaContribuyente,
  ArcaCredenciales,
  ArcaDatos,
  ArcaPortalPort,
  ArcaSincronizacionResultado,
} from '../ports/arca-portal.port';
import {
  comoLista,
  mapearComprobante,
  mapearDeudas,
  mapearPresentaciones,
  mapearVencimientos,
  mapearVencimientosCtacte,
  mapearVeps,
  presentacionesAceptadas,
  type PortalVencimiento,
  type SetiPresentacion,
  type SetiVep,
} from './arca-mapeos';

const LOGIN_URL = 'https://auth.afip.gob.ar/contribuyente_/login.xhtml';
const PORTAL = 'https://portalcf.cloud.afip.gob.ar/portal';
const SETI = 'https://seti.afip.gob.ar/setiweb';
const MCMP = 'https://fes.afip.gob.ar/mcmp/jsp';
const TIMEOUT_MS = 60_000;
const ORDEN_PRESENTACIONES = encodeURIComponent('{"valor":"FECHA_PRESENTACION","tipo":"desc"}');
const ORDEN_VEPS = encodeURIComponent('{"valor":"vepId","tipo":"desc"}');

/**
 * Entra a ARCA con la clave fiscal del cliente usando un navegador sin
 * ventana (Chromium vía Playwright), igual que lo haría una persona, y lee los
 * bloques de la pestaña ARCA de los mismos servicios web que usa el portal
 * (sus respuestas JSON, no el HTML de las pantallas), para el propio cliente y
 * para cada persona que representa en ARCA (ej. una sociedad):
 *
 * - Vencimientos: agenda del Portal de Clave Fiscal (`/portal/api/vencimientos`,
 *   solo el CUIT propio) o Cuentas Tributarias (representados).
 * - Deudas: "Estado de cuenta" (Sistema de Cuentas Tributarias), intereses al día.
 * - Presentaciones y VEP: servicio "Presentación de DDJJ y Pagos" (SETI), más las
 *   DDJJ faltantes que informa Cuentas Tributarias.
 * - Comprobantes: servicio "Mis Comprobantes", emitidos (venta) y recibidos (compra).
 *
 * Cada bloque se lee por separado: si uno falla (ej. el cliente no tiene ese
 * servicio habilitado), queda en `null` con el motivo en `notas` y el resto
 * sigue. Límites conocidos: se rompe si ARCA cambia esos servicios o pide
 * captcha. Requiere el navegador instalado una vez en el servidor:
 * `npx playwright-core install chromium`.
 */
@Injectable()
export class ArcaPlaywrightAdapter implements ArcaPortalPort {
  private readonly logger = new Logger(ArcaPlaywrightAdapter.name);

  async sincronizar(credenciales: ArcaCredenciales): Promise<ArcaSincronizacionResultado> {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      context.setDefaultTimeout(TIMEOUT_MS);
      const page = await context.newPage();
      await this.login(page, credenciales);

      const { cuit: cuitPropio } = credenciales;
      const datosPorCuit: Record<string, ArcaDatos> = {};
      const datosDe = (cuit: string) => (datosPorCuit[cuit] ??= { ...ARCA_DATOS_VACIOS, notas: {} });
      const bloque = async <T>(cuits: string[], nombres: ArcaBloque[], leer: () => Promise<T>): Promise<T | null> => {
        try {
          return await leer();
        } catch (error) {
          const mensaje = error instanceof Error ? error.message : 'error desconocido';
          this.logger.warn(`ARCA ${nombres.join('/')} (${cuits.join(', ')}): ${mensaje}`);
          for (const c of cuits) for (const n of nombres) datosDe(c).notas[n] = `No se pudo leer de ARCA: ${mensaje}`;
          return null;
        }
      };

      // La agenda del portal solo responde para el CUIT con el que se entró.
      const agenda = await bloque([cuitPropio], ['vencimientos'], () =>
        this.getJson<{ data: PortalVencimiento[] }>(page, `${PORTAL}/api/vencimientos/${cuitPropio}`).then(
          (r) => r.data ?? [],
        ),
      );

      // SETI: a quién representa, y DDJJ + VEP de cada uno.
      let contribuyentes: ArcaContribuyente[] = [{ cuit: cuitPropio, nombre: '' }];
      const seti = await bloque([cuitPropio], ['presentaciones', 'veps'], async () => {
        const p = await this.abrirServicio(context, page, 'PRESENTACIÓN DE DDJJ Y PAGOS', /seti\.afip\.gob\.ar/);
        const relaciones = setiData(
          await this.getJson<SetiRespuesta<{ cuit: string; razonsocial: string }[]>>(p, `${SETI}/api/session/usuario/relaciones`),
        );
        contribuyentes = ordenarContribuyentes(
          (relaciones ?? []).map((r) => ({ cuit: String(r.cuit), nombre: r.razonsocial })),
          cuitPropio,
        );
        const porCuit: Record<string, { presentadas: SetiPresentacion[]; falta: Record<string, unknown>[]; veps: SetiVep[] }> = {};
        for (const { cuit } of contribuyentes) {
          const base = `usuario=TODOS&contribuyente=${cuit}&mes=-&anio=-&pagina=1&totalPagina=50&cantTotal=0`;
          const [presentadas, falta, pagos] = await Promise.all([
            this.getJson<SetiRespuesta<{ resultados: SetiPresentacion[] }>>(
              p,
              `${SETI}/api/presentaciones/?${base}&formulario=&orden=${ORDEN_PRESENTACIONES}`,
            ),
            this.getJson<SetiRespuesta<Record<string, unknown>[]>>(p, `${SETI}/api/deudas/faltadepresentacion?cuit=${cuit}`),
            this.getJson<SetiRespuesta<{ vepsConsultados: SetiVep[] }>>(
              p,
              `${SETI}/api/pagos?${base}&estado=seticommon.todos.rotulo&tipoDePago=TODOS&ultimosMeses=12&orden=${ORDEN_VEPS}`,
            ),
          ]);
          porCuit[cuit] = {
            presentadas: setiData(presentadas)?.resultados ?? [],
            falta: setiData(falta) ?? [],
            veps: setiData(pagos)?.vepsConsultados ?? [],
          };
        }
        await p.close();
        return porCuit;
      });
      const cuits = contribuyentes.map((c) => c.cuit);

      // Cuentas Tributarias ("Estado de cuenta"): deudas, DDJJ faltantes y, para los
      // representados, vencimientos.
      const ctacte = await bloque(cuits, ['deudas'], () => this.leerCuentasTributarias(context, page, cuits));

      for (const cuit of cuits) {
        const datos = datosDe(cuit);
        const deSeti = seti?.[cuit];
        const deCtacte = ctacte?.[cuit];
        const agendaCuit = cuit === cuitPropio ? (agenda ?? []) : [];
        const aceptadas = presentacionesAceptadas(deSeti?.presentadas ?? []);

        if (cuit === cuitPropio) {
          if (agenda) datos.vencimientos = mapearVencimientos(agenda, aceptadas);
        } else if (deCtacte) {
          datos.vencimientos = mapearVencimientosCtacte(deCtacte.vencimientos);
        } else if (!datos.notas.vencimientos) {
          datos.notas.vencimientos = datos.notas.deudas;
        }
        if (deCtacte) datos.deudas = mapearDeudas(deCtacte.deudas);
        if (deSeti) {
          datos.presentaciones = mapearPresentaciones(
            deSeti.presentadas,
            // Primero las de Cuentas Tributarias: traen el concepto (ej. "Participaciones societarias").
            [...(deCtacte?.faltas ?? []), ...deSeti.falta],
            agendaCuit,
            aceptadas,
          );
          datos.veps = mapearVeps(deSeti.veps);
        } else if (cuit !== cuitPropio) {
          datos.notas.presentaciones = datosDe(cuitPropio).notas.presentaciones;
          datos.notas.veps = datosDe(cuitPropio).notas.veps;
        }
      }

      await bloque(cuits, ['comprobantes'], () => this.leerComprobantes(context, page, cuits, datosDe));
      return { contribuyentes, datosPorCuit };
    } finally {
      await browser.close();
    }
  }

  /**
   * Cuentas Tributarias responde según el contribuyente elegido en su selector de
   * arriba a la derecha (ignora el CUIT que se le pasa), así que se elige cada uno
   * antes de pedir sus datos.
   */
  private async leerCuentasTributarias(context: BrowserContext, portal: Page, cuits: string[]) {
    await portal.goto(`${PORTAL}/app/`, { waitUntil: 'domcontentloaded' });
    const acceso = portal.getByText('Estado de cuenta', { exact: true }).first();
    await acceso.waitFor();
    const [p] = await Promise.all([context.waitForEvent('page', { timeout: 30_000 }), acceso.click()]);
    await p.waitForURL(/ctacte\.cloud\.afip\.gob\.ar/);
    await p.waitForLoadState('load');

    const resultado: Record<string, { deudas: Record<string, unknown>[]; faltas: Record<string, unknown>[]; vencimientos: Record<string, unknown>[] }> = {};
    const selector = p.locator('select[name="$PropertySelection"]');
    for (const cuit of cuits) {
      if (await selector.count()) {
        const opciones = await selector.locator('option').allTextContents();
        if (!opciones.map((o) => o.trim()).includes(cuit)) continue;
        const actual = (await selector.locator('option:checked').textContent())?.trim();
        if (actual !== cuit) {
          await Promise.all([p.waitForLoadState('load'), selector.selectOption({ label: cuit })]);
          await p.waitForTimeout(2000);
        }
      } else if (cuit !== cuits[0]) {
        continue;
      }
      const llamar = (metodo: string, args: unknown[]) =>
        this.getJson<CtacteRespuesta>(
          p,
          `https://ctacte.cloud.afip.gob.ar/contribuyente/rest-access/service?request=${encodeURIComponent(
            JSON.stringify({ serviceName: CTACTE_SERVICIO, methodName: metodo, arguments: args }),
          )}`,
        ).then(ctacteData);
      const [deudas, faltas, vencimientos] = await Promise.all([
        llamar('getDeudas', [Number(cuit), null]),
        llamar('getFaltasPresentacion', [Number(cuit)]),
        llamar('getVencimientos', [Number(cuit)]),
      ]);
      resultado[cuit] = {
        deudas: comoLista(deudas?.deuda as Record<string, unknown>[]),
        faltas: comoLista(faltas?.deuda as Record<string, unknown>[]),
        vencimientos: comoLista(vencimientos?.vencimiento as Record<string, unknown>[]),
      };
    }
    await p.close();
    return resultado;
  }

  private async leerComprobantes(
    context: BrowserContext,
    portal: Page,
    cuits: string[],
    datosDe: (cuit: string) => ArcaDatos,
  ): Promise<void> {
    const p = await this.abrirServicio(context, portal, 'MIS COMPROBANTES', /fes\.afip\.gob\.ar\/mcmp/);
    await p.goto(`${MCMP}/comprobantesEmitidos.do`, { waitUntil: 'domcontentloaded' });
    const disponibles = await p.$$eval('#cuitConsultada option', (os) => os.map((o) => (o as HTMLOptionElement).value));

    // Desde el 1 de enero del año pasado hasta ayer (ARCA informa hasta ayer), para que
    // los atajos "Este año"/"Año pasado" del selector de período tengan datos. Una
    // consulta por año calendario, para no pasar el tope de rango de Mis Comprobantes.
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rangos = [
      `01/01/${ayer.getFullYear() - 1} - 31/12/${ayer.getFullYear() - 1}`,
      `01/01/${ayer.getFullYear()} - ${ddmmyyyy(ayer)}`,
    ];
    const clasesPorTipo: Record<string, Map<string, string>> = {};
    for (const t of ['E', 'R']) {
      const tipos = await this.getJson<{ datos: { clave: string; valor: string }[] }>(p, `${MCMP}/ajax.do?f=tiposComprobantes&t=${t}`);
      clasesPorTipo[t] = new Map((tipos.datos ?? []).map((x) => [x.clave, x.valor]));
    }

    for (const cuit of cuits) {
      const datos = datosDe(cuit);
      if (!disponibles.includes(cuit)) {
        datos.notas.comprobantes =
          `ARCA no ofrece "Mis Comprobantes" del CUIT ${cuit} con esta clave fiscal. ` +
          'Hay que habilitar el servicio para este CUIT en el Administrador de Relaciones de ARCA.';
        continue;
      }
      try {
        const resultado = [];
        for (const [t, tipo] of [['E', 'venta'], ['R', 'compra']] as const) {
          for (const rango of rangos) {
            const filas = await this.consultarMcmp(p, t, rango, cuit);
            resultado.push(...filas.map((f) => mapearComprobante(f, tipo, clasesPorTipo[t])));
          }
        }
        datos.comprobantes = resultado.sort((a, b) => b.fecha.localeCompare(a.fecha));
      } catch (error) {
        datos.notas.comprobantes = `No se pudo leer de ARCA: ${error instanceof Error ? error.message : 'error desconocido'}`;
      }
    }
    await p.close();
  }

  /** Mis Comprobantes procesa la consulta en diferido: se genera y después se pide el resultado. */
  private async consultarMcmp(p: Page, t: 'E' | 'R', rango: string, cuit: string): Promise<(string | null)[][]> {
    const url = `${MCMP}/ajax.do?f=generarConsulta&t=${t}&fechaEmision=${encodeURIComponent(rango)}&tiposComprobantes=&cuitConsultada=${cuit}`;
    let generada: { estado: string; datos?: { idConsulta: string } } | undefined;
    // Si se generan dos consultas muy seguidas, ARCA contesta un código "BL..." en vez
    // de JSON: se espera y se reintenta.
    for (let intento = 0; !generada; intento += 1) {
      await p.waitForTimeout(3000);
      try {
        generada = await this.getJson(p, url);
      } catch (error) {
        if (intento >= 3) throw error;
        await p.waitForTimeout(5000 * (intento + 1));
      }
    }
    const id = generada.datos?.idConsulta;
    if (!id) throw new Error(`Mis Comprobantes no generó la consulta (${t})`);
    for (let intento = 0; intento < 10; intento += 1) {
      const lista = await this.getJson<{ datos?: { consulta?: { estado?: string; error?: string }; data?: (string | null)[][] } }>(
        p,
        `${MCMP}/ajax.do?f=listaResultados&id=${id}`,
      );
      const consulta = lista.datos?.consulta;
      if (consulta?.error) throw new Error(`Mis Comprobantes: ${consulta.error}`);
      if (lista.datos?.data?.length || (consulta?.estado && consulta.estado !== 'PE')) {
        return lista.datos?.data ?? [];
      }
      await p.waitForTimeout(2000);
    }
    throw new Error('Mis Comprobantes tardó demasiado en responder');
  }

  /**
   * Abre un servicio desde "Mis servicios" del portal (ARCA lo abre en una
   * pestaña nueva ya autenticada) y espera a que cargue.
   */
  private async abrirServicio(context: BrowserContext, portal: Page, titulo: string, destino: RegExp): Promise<Page> {
    await portal.goto(`${PORTAL}/app/mis-servicios`, { waitUntil: 'domcontentloaded' });
    const tarjeta = portal.getByText(titulo, { exact: true }).first();
    await tarjeta.waitFor();
    const [nueva] = await Promise.all([context.waitForEvent('page', { timeout: 30_000 }), tarjeta.click()]);
    await nueva.waitForURL(destino);
    await nueva.waitForLoadState('domcontentloaded');
    await nueva.waitForTimeout(3000);
    return nueva;
  }

  /** GET dentro de la sesión del navegador (cookies de ARCA incluidas). */
  private async getJson<T>(p: Page, url: string): Promise<T> {
    const { status, texto } = await p.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return { status: r.status, texto: await r.text() };
    }, url);
    if (status !== 200) throw new Error(`ARCA respondió ${status}`);
    try {
      return JSON.parse(texto) as T;
    } catch {
      throw new Error(`ARCA devolvió una respuesta inesperada: ${texto.slice(0, 80)}`);
    }
  }

  private async login(page: Page, { cuit, password }: ArcaCredenciales): Promise<void> {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    await page.fill('[id="F1:username"]', cuit);
    await page.click('[id="F1:btnSiguiente"]');

    const paso2 = await Promise.race([
      page.waitForSelector('[id="F1:password"]').then(() => 'password' as const),
      page.waitForSelector('.alert-danger, [id="F1:msg"]').then(() => 'error' as const),
    ]);
    if (paso2 === 'error') {
      throw new Error(`ARCA rechazó el CUIT: ${await this.mensajeError(page)}`);
    }
    await this.verificarCaptcha(page);

    await page.fill('[id="F1:password"]', password);
    await page.click('[id="F1:btnIngresar"]');

    // Si no llega al portal, la clave no fue aceptada.
    await page.waitForURL(/portalcf\.cloud\.afip\.gob\.ar/, { timeout: 30_000 }).catch(() => undefined);
    if (!page.url().includes('portalcf.cloud.afip.gob.ar')) {
      await this.verificarCaptcha(page);
      throw new Error(`ARCA no aceptó la clave fiscal: ${await this.mensajeError(page)}`);
    }
  }

  private async verificarCaptcha(page: Page): Promise<void> {
    // Solo cuenta si está a la vista: el login de ARCA trae elementos de captcha ocultos siempre.
    const visible = await page.$$eval('iframe[src*="captcha"], [id*="captcha" i], .g-recaptcha', (els) =>
      els.some((e) => (e as HTMLElement).offsetWidth > 0 || (e as HTMLElement).offsetHeight > 0),
    );
    if (visible) {
      throw new Error('ARCA pidió un captcha; no se puede entrar automáticamente en este momento');
    }
  }

  private async mensajeError(page: Page): Promise<string> {
    const el = await page.$('.alert-danger, [id="F1:msg"], .ui-messages-error');
    const texto = el ? (await el.innerText()).trim() : '';
    return texto || 'sin detalle';
  }
}

interface SetiRespuesta<T> {
  success: boolean;
  data: T | null;
  error: string;
}

function setiData<T>(r: SetiRespuesta<T>): T | null {
  if (!r.success) throw new Error(r.error || 'SETI respondió con error');
  return r.data;
}

const CTACTE_SERVICIO = 'afip.dit.sct.homeContribuyenteView.services.HomeContribuyenteViewService';

interface CtacteRespuesta {
  'afip.dit.sct.restaccessCommon.model.Respuesta': {
    data: Record<string, unknown> | '' | null;
    status: { tipoEstado: string; mensaje?: string };
  };
}

function ctacteData(r: CtacteRespuesta): Record<string, unknown> | null {
  const respuesta = r['afip.dit.sct.restaccessCommon.model.Respuesta'];
  if (respuesta?.status?.tipoEstado !== 'SUCCESS') {
    throw new Error(respuesta?.status?.mensaje || 'Cuentas Tributarias respondió con error');
  }
  return respuesta.data || null;
}

/** El propio CUIT primero; si ARCA no lo lista (no debería pasar), se agrega igual. */
function ordenarContribuyentes(lista: ArcaContribuyente[], cuitPropio: string): ArcaContribuyente[] {
  const propio = lista.find((c) => c.cuit === cuitPropio) ?? { cuit: cuitPropio, nombre: '' };
  return [propio, ...lista.filter((c) => c.cuit !== cuitPropio)];
}

function ddmmyyyy(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
