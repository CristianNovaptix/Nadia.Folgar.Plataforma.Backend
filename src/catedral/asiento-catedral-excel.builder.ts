import ExcelJS from 'exceljs';
import { LineaAsientoResuelta } from '../asientos-contables/asiento-contable.service';

export interface AsientoCatedralExcelMes {
  /** "YYYY-MM" — se postea con la fecha del último día del mes. */
  periodo: string;
  lineas: LineaAsientoResuelta[];
}

export interface AsientoCatedralExcelInput {
  banco: string;
  /** Un bloque por mes calendario del extracto — ver `construirAsientosMensuales` en `asiento-contable.logic.ts`. */
  meses: AsientoCatedralExcelMes[];
}

const COLUMNAS = [
  'Número de asiento',
  'Fecha',
  'Código de cuenta',
  'Detalle del pase',
  'Debe',
  'Haber',
  'Descripción del asiento',
] as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Fecha del último día del período "YYYY-MM", formato DD/MM/AAAA (convención argentina) — sin pasar por `Date` para no arrastrar corrimientos de zona horaria. */
function fechaFinDePeriodo(periodo: string): string {
  const [anioStr, mesStr] = periodo.split('-');
  const anio = Number(anioStr);
  const mes = Number(mesStr);
  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${pad2(ultimoDia)}/${pad2(mes)}/${anio}`;
}

/**
 * Genera la planilla de asientos en el layout deducido del instructivo
 * interno "Importar asientos Sueldos a Catedral.docx": una fila por línea de
 * Debe o Haber (nunca una fila de "totales"), agrupadas por
 * `Número de asiento` repetido, `Detalle del pase` siempre vacío, y
 * `Descripción del asiento` solo en la primera fila de cada asiento.
 *
 * Un extracto que abarca más de un mes calendario genera un bloque por mes,
 * apilados en la misma hoja "Asientos" — mismo patrón que se ve en el Excel
 * real de Santander/Interprints (12 bloques mensuales, uno por mes,
 * numerados secuencialmente) — en vez de un único asiento para todo el rango.
 *
 * Layout NO confirmado pixel a pixel contra una planilla real "Generada"
 * por Catedral (riesgo aceptado, ver plan) — queda deliberadamente aislado acá
 * para poder ajustar rápido columnas/formato el día que se consiga una.
 */
export async function generarPlanillaAsientoCatedral(
  input: AsientoCatedralExcelInput,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const hoja = workbook.addWorksheet('Asientos');
  hoja.addRow([...COLUMNAS]);

  input.meses.forEach((mes, numeroAsientoIndex) => {
    const numeroAsiento = numeroAsientoIndex + 1;
    const fecha = fechaFinDePeriodo(mes.periodo);
    const descripcionAsiento = `Movimientos bancarios ${input.banco} ${mes.periodo}`;

    mes.lineas.forEach((linea, index) => {
      hoja.addRow([
        numeroAsiento,
        fecha,
        linea.codigo,
        '',
        linea.lado === 'debe' ? linea.monto : '',
        linea.lado === 'haber' ? linea.monto : '',
        index === 0 ? descripcionAsiento : '',
      ]);
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
