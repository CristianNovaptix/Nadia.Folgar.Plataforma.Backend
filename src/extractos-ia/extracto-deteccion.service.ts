import { Injectable } from '@nestjs/common';

export interface EncabezadoDetectado {
  /** CUIT normalizado con guiones (ej. "30-71234567-8"), si se encontró alguno con formato válido. */
  cuitDetectado?: string;
  /** Mes que cubre el extracto, formato "YYYY-MM", si se pudo inferir con confianza. */
  periodoDetectado?: string;
  /** Fecha "hasta" del rango del extracto, formato "YYYY-MM-DD" — de ahí sale `periodoDetectado`. */
  fechaHastaDetectada?: string;
  /** Banco emisor del extracto (el más mencionado en el texto) — para elegir la cuenta bancaria. */
  bancoDetectado?: BancoDetectado;
}

export interface BancoDetectado {
  nombre: string;
  /** Formas en que puede aparecer escrito (en el PDF o en `CuentaBancaria.banco`), normalizadas. */
  palabrasClave: string[];
}

/**
 * Bancos conocidos y cómo se los nombra. Se elige el que más veces aparece en el texto, porque un
 * extracto también menciona otros bancos en sus movimientos (transferencias, cheques de otra
 * entidad), pero ninguno tantas veces como el propio.
 */
const BANCOS: BancoDetectado[] = [
  { nombre: 'Santander', palabrasClave: ['santander'] },
  { nombre: 'Galicia', palabrasClave: ['galicia'] },
  { nombre: 'Provincia', palabrasClave: ['provincia', 'pcia', 'bapro'] },
  { nombre: 'Credicoop', palabrasClave: ['credicoop'] },
  { nombre: 'Nación', palabrasClave: ['banco de la nacion', 'banco nacion', 'bna'] },
  { nombre: 'Macro', palabrasClave: ['macro'] },
  { nombre: 'BBVA', palabrasClave: ['bbva', 'frances'] },
  { nombre: 'ICBC', palabrasClave: ['icbc'] },
  { nombre: 'HSBC', palabrasClave: ['hsbc'] },
  { nombre: 'Patagonia', palabrasClave: ['patagonia'] },
  { nombre: 'Ciudad', palabrasClave: ['banco ciudad', 'ciudad de buenos aires'] },
  { nombre: 'Supervielle', palabrasClave: ['supervielle'] },
  { nombre: 'Comafi', palabrasClave: ['comafi'] },
  { nombre: 'Itaú', palabrasClave: ['itau'] },
  { nombre: 'Brubank', palabrasClave: ['brubank'] },
  { nombre: 'Hipotecario', palabrasClave: ['hipotecario'] },
  { nombre: 'Industrial', palabrasClave: ['bind', 'banco industrial'] },
  { nombre: 'Mercado Pago', palabrasClave: ['mercado pago', 'mercadopago'] },
];

function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** Cantidad mínima de fechas repetidas con el mismo mes/año para inferir el período por moda. */
const MINIMO_REPETICIONES_FECHA = 2;

const REGEX_CUIT = /(\d{2})-?(\d{8})-?(\d{1})/g;
const REGEX_FECHA = /(\d{2})[/-](\d{2})[/-](\d{4})/g;
const REGEX_PERIODO_CON_FECHA = /per[ií]odo[^\d]{0,15}\d{1,2}[/-](\d{2})[/-](\d{4})/i;

const FECHA = String.raw`\d{1,2}[/-]\d{1,2}[/-]\d{2,4}`;
const FECHA_CAPTURADA = String.raw`(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})`;

/**
 * Fecha "hasta" del rango que cubre el extracto — el período es el mes de esa fecha.
 * Formatos reales vistos: Santander "Hasta: 31/07/24", Credicoop "del: 01/04/2025 al:
 * 30/04/2025", Galicia "ENTRE EL 30-12-2024 Y EL 31-01-2025". "Hasta" exige los dos puntos
 * para no tomar descripciones de movimientos ("COMISION ... DESDE 01-03-2025 HASTA 31-03").
 */
const REGEXES_FECHA_HASTA = [
  new RegExp(String.raw`hasta\s*:\s*${FECHA_CAPTURADA}`, 'i'),
  new RegExp(String.raw`\bdel\s*:?\s*${FECHA}\s+al\s*:?\s*${FECHA_CAPTURADA}`, 'i'),
  new RegExp(String.raw`\bentre\s+el\s+${FECHA}\s+y\s+el\s+${FECHA_CAPTURADA}`, 'i'),
  // Provincia: "PERIODO (27-03-2025/28-04-2025)".
  new RegExp(String.raw`per[ií]odo[^\d]{0,15}${FECHA}\s*(?:/|-|al?)\s*${FECHA_CAPTURADA}`, 'i'),
];

const MESES_ES: Record<string, string> = {
  enero: '01',
  febrero: '02',
  marzo: '03',
  abril: '04',
  mayo: '05',
  junio: '06',
  julio: '07',
  agosto: '08',
  septiembre: '09',
  setiembre: '09',
  octubre: '10',
  noviembre: '11',
  diciembre: '12',
};

const REGEX_PERIODO_CON_MES = new RegExp(
  `per[ií]odo[^\\d]{0,20}?(${Object.keys(MESES_ES).join('|')})[^\\d]{0,5}(\\d{4})`,
  'i',
);

/**
 * Detección determinística (sin IA) de CUIT y período a partir del texto plano
 * ya extraído de un extracto bancario, para el flujo de auto-detección
 * previo a la carga (ver `POST /extractos-ia/analizar`). Mismo espíritu que
 * `PdfTextExtractorService`: nunca delegarle a un LLM algo que un dato de
 * formato fijo (CUIT) o una búsqueda de palabra clave (período) puede resolver
 * con certeza.
 *
 * Es deliberadamente conservador: si no encuentra un dato con confianza
 * razonable, devuelve `undefined` en vez de adivinar — quien llama (el
 * contador, vía el Frontend) completa el dato a mano, igual que antes de que
 * existiera esta detección.
 */
@Injectable()
export class ExtractoDeteccionService {
  detectar(texto: string): EncabezadoDetectado {
    const fechaHastaDetectada = this.detectarFechaHasta(texto);
    return {
      cuitDetectado: this.detectarCuit(texto),
      periodoDetectado: fechaHastaDetectada?.slice(0, 7) ?? this.detectarPeriodo(texto),
      fechaHastaDetectada,
      bancoDetectado: this.detectarBanco(texto),
    };
  }

  private detectarBanco(texto: string): BancoDetectado | undefined {
    const normalizado = normalizar(texto);
    let mejor: BancoDetectado | undefined;
    let mejorConteo = 0;
    for (const banco of BANCOS) {
      const conteo = banco.palabrasClave.reduce(
        (total, palabra) =>
          total + (normalizado.match(new RegExp(String.raw`\b${palabra}\b`, 'g'))?.length ?? 0),
        0,
      );
      if (conteo > mejorConteo) {
        mejor = banco;
        mejorConteo = conteo;
      }
    }
    return mejor;
  }

  /** Primera fecha "hasta" reconocida (`REGEXES_FECHA_HASTA`), como "YYYY-MM-DD". */
  private detectarFechaHasta(texto: string): string | undefined {
    for (const regex of REGEXES_FECHA_HASTA) {
      const match = texto.match(regex);
      if (!match) continue;
      const dia = Number(match[1]);
      const mes = Number(match[2]);
      if (dia < 1 || dia > 31 || mes < 1 || mes > 12) continue;
      const anio = match[3].length === 2 ? `20${match[3]}` : match[3];
      return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    }
    return undefined;
  }

  /**
   * Prioriza el CUIT que aparece cerca de la palabra "CUIT" (más confiable:
   * es casi siempre el del titular de la cuenta, no un número de comprobante
   * con el mismo largo por casualidad). Si no hay ninguno con esa cercanía,
   * cae al primer CUIT con formato válido que aparezca en el texto.
   */
  private detectarCuit(texto: string): string | undefined {
    const indiceCuit = texto.search(/cuit/i);
    if (indiceCuit >= 0) {
      const ventana = texto.slice(indiceCuit, indiceCuit + 40);
      const matchCercano = ventana.match(/(\d{2})-?(\d{8})-?(\d{1})/);
      if (matchCercano) {
        return this.normalizarCuit(matchCercano);
      }
    }

    REGEX_CUIT.lastIndex = 0;
    const primerMatch = REGEX_CUIT.exec(texto);
    return primerMatch ? this.normalizarCuit(primerMatch) : undefined;
  }

  private normalizarCuit(match: RegExpMatchArray): string {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  /**
   * Primero busca una mención explícita "Período ... dd/mm/yyyy" o
   * "Período ... <mes en español> yyyy" en el encabezado. Si no hay, cae a la
   * moda (mes, año) de todas las fechas dd/mm/yyyy del texto — con un mínimo
   * de repeticiones para no adivinar un período a partir de una única fecha
   * suelta (ej. la fecha de un comprobante aislado).
   */
  private detectarPeriodo(texto: string): string | undefined {
    const matchFecha = texto.match(REGEX_PERIODO_CON_FECHA);
    if (matchFecha) {
      return `${matchFecha[2]}-${matchFecha[1]}`;
    }

    const matchMes = texto.match(REGEX_PERIODO_CON_MES);
    if (matchMes) {
      const mes = MESES_ES[matchMes[1].toLowerCase()];
      const anio = matchMes[2];
      return `${anio}-${mes}`;
    }

    return this.detectarPeriodoPorModaDeFechas(texto);
  }

  private detectarPeriodoPorModaDeFechas(texto: string): string | undefined {
    const conteos = new Map<string, number>();

    REGEX_FECHA.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REGEX_FECHA.exec(texto)) !== null) {
      const [, , mes, anio] = match;
      const mesNumero = Number(mes);
      if (mesNumero < 1 || mesNumero > 12) continue;
      const clave = `${anio}-${mes}`;
      conteos.set(clave, (conteos.get(clave) ?? 0) + 1);
    }

    let mejorClave: string | undefined;
    let mejorConteo = 0;
    for (const [clave, conteo] of conteos) {
      if (conteo > mejorConteo) {
        mejorClave = clave;
        mejorConteo = conteo;
      }
    }

    return mejorConteo >= MINIMO_REPETICIONES_FECHA ? mejorClave : undefined;
  }
}
