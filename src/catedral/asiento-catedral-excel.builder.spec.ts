import ExcelJS from 'exceljs';
import { generarPlanillaAsientoCatedral } from './asiento-catedral-excel.builder';
import { LineaAsientoResuelta } from '../asientos-contables/asiento-contable.service';

describe('generarPlanillaAsientoCatedral', () => {
  const lineas: LineaAsientoResuelta[] = [
    {
      cuentaContableId: 'c1',
      codigo: '519',
      nombre: 'Gastos Bancarios',
      lado: 'debe',
      monto: 1200,
    },
    { cuentaContableId: 'c2', codigo: '2111', nombre: 'Proveedores', lado: 'debe', monto: 5260000 },
    {
      cuentaContableId: 'c3',
      codigo: '1119',
      nombre: 'Banco Credicoop',
      lado: 'haber',
      monto: 5261200,
    },
  ];

  it('arma el layout de columnas del instructivo, con Detalle del pase vacío y descripción solo en la primera línea', async () => {
    const buffer = await generarPlanillaAsientoCatedral({
      banco: 'Credicoop',
      meses: [{ periodo: '2025-04', lineas }],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const hoja = workbook.getWorksheet('Asientos');
    expect(hoja).toBeDefined();

    const header = hoja!.getRow(1).values as unknown[];
    expect(header.slice(1)).toEqual([
      'Número de asiento',
      'Fecha',
      'Código de cuenta',
      'Detalle del pase',
      'Debe',
      'Haber',
      'Descripción del asiento',
    ]);

    expect(hoja!.rowCount).toBe(1 + lineas.length);

    const fila1 = hoja!.getRow(2).values as unknown[];
    expect(fila1.slice(1)).toEqual([
      1,
      '30/04/2025',
      '519',
      '',
      1200,
      '',
      'Movimientos bancarios Credicoop 2025-04',
    ]);

    const fila2 = hoja!.getRow(3).values as unknown[];
    expect(fila2.slice(1)).toEqual([1, '30/04/2025', '2111', '', 5260000, '', '']);

    const fila3 = hoja!.getRow(4).values as unknown[];
    expect(fila3.slice(1)).toEqual([1, '30/04/2025', '1119', '', '', 5261200, '']);
  });

  it('nunca agrega una fila de totales', async () => {
    const buffer = await generarPlanillaAsientoCatedral({
      banco: 'Galicia',
      meses: [{ periodo: '2025-01', lineas }],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const hoja = workbook.getWorksheet('Asientos')!;

    expect(hoja.rowCount).toBe(1 + lineas.length);
  });

  it('calcula la fecha como el último día del período, sin corrimientos de mes', async () => {
    const buffer = await generarPlanillaAsientoCatedral({
      banco: 'Provincia',
      meses: [{ periodo: '2024-02', lineas: [lineas[0]] }],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const hoja = workbook.getWorksheet('Asientos')!;
    const fila1 = hoja.getRow(2).values as unknown[];
    expect(fila1[2]).toBe('29/02/2024');
  });

  it('un extracto de dos meses arma dos bloques apilados, con Número de asiento secuencial (1, 2)', async () => {
    const lineasMarzo: LineaAsientoResuelta[] = [
      {
        cuentaContableId: 'c1',
        codigo: '519',
        nombre: 'Gastos Bancarios',
        lado: 'debe',
        monto: 300,
      },
      { cuentaContableId: 'cb', codigo: '114', nombre: 'Banco Galicia', lado: 'haber', monto: 300 },
    ];
    const lineasAbril: LineaAsientoResuelta[] = [
      {
        cuentaContableId: 'c1',
        codigo: '519',
        nombre: 'Gastos Bancarios',
        lado: 'debe',
        monto: 200,
      },
      { cuentaContableId: 'cb', codigo: '114', nombre: 'Banco Galicia', lado: 'haber', monto: 200 },
    ];

    const buffer = await generarPlanillaAsientoCatedral({
      banco: 'Galicia',
      meses: [
        { periodo: '2025-03', lineas: lineasMarzo },
        { periodo: '2025-04', lineas: lineasAbril },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const hoja = workbook.getWorksheet('Asientos')!;

    expect(hoja.rowCount).toBe(1 + lineasMarzo.length + lineasAbril.length);

    // Bloque de marzo: filas 2-3, Número de asiento = 1, fecha fin de marzo.
    expect((hoja.getRow(2).values as unknown[]).slice(1)).toEqual([
      1,
      '31/03/2025',
      '519',
      '',
      300,
      '',
      'Movimientos bancarios Galicia 2025-03',
    ]);
    expect((hoja.getRow(3).values as unknown[])[1]).toBe(1);

    // Bloque de abril: filas 4-5, Número de asiento = 2, fecha fin de abril.
    expect((hoja.getRow(4).values as unknown[]).slice(1)).toEqual([
      2,
      '30/04/2025',
      '519',
      '',
      200,
      '',
      'Movimientos bancarios Galicia 2025-04',
    ]);
    expect((hoja.getRow(5).values as unknown[])[1]).toBe(2);
  });
});
