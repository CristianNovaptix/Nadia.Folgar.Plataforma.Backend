import { Injectable, Logger } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';

/** Umbral mínimo de caracteres útiles (sin espacios) para considerar que el PDF tiene capa de texto. */
const MIN_CARACTERES_UTILES = 50;

export interface TextoPdfExtraido {
  texto: string;
  tieneCapaDeTexto: boolean;
  /** Texto de cada página, en orden — para partir extractos largos (ver `extraccion-por-tramos.ts`). */
  paginas?: string[];
}

/**
 * Extrae el texto plano de un PDF de forma determinística, sin IA — sirve dos
 * propósitos:
 *  1. Detectar PDFs sin capa de texto (probablemente escaneados, FOLGAR-010)
 *     ANTES de gastar una llamada al proveedor de IA.
 *  2. Darle a la IA el texto ya extraído en vez del PDF binario completo: más
 *     barato en tokens y sin los límites de tamaño de documento del proveedor.
 *
 * Deliberadamente no intenta reconstruir columnas por coordenadas x/y — eso
 * requeriría calibración por banco, justo lo que se quiere evitar para que la
 * herramienta escale a bancos nuevos sin cambios de código. La interpretación
 * de la tabla de movimientos queda 100% del lado de la IA (ver
 * `AiExtractionPort`), que trabaja sobre el texto plano.
 */
@Injectable()
export class PdfTextExtractorService {
  private readonly logger = new Logger(PdfTextExtractorService.name);

  async extraer(contenidoBase64: string): Promise<TextoPdfExtraido> {
    if (!contenidoBase64) {
      return { texto: '', tieneCapaDeTexto: false };
    }

    let parser: PDFParse | undefined;
    try {
      const buffer = Buffer.from(contenidoBase64, 'base64');
      parser = new PDFParse({ data: buffer });
      const resultado = await parser.getText();
      const texto = resultado.text ?? '';
      const caracteresUtiles = texto.replace(/\s/g, '').length;

      return {
        texto,
        tieneCapaDeTexto: caracteresUtiles >= MIN_CARACTERES_UTILES,
        paginas: (resultado.pages ?? []).map((pagina) => pagina.text ?? ''),
      };
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : 'Error desconocido';
      this.logger.warn(`No se pudo parsear el PDF: ${mensaje}`);
      return { texto: '', tieneCapaDeTexto: false };
    } finally {
      await parser?.destroy();
    }
  }
}
