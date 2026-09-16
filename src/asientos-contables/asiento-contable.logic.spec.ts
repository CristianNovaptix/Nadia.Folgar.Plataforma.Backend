import {
  ReglaParaClasificar,
  MovimientoParaClasificar,
  clasificarMovimientos,
  construirLineasAsiento,
  agruparMovimientosPorMes,
  construirAsientosMensuales,
} from './asiento-contable.logic';

const CUENTA_BANCARIA_ID = 'cb-1';
const CUENTA_BANCO = 'cuenta-banco-santander';

function regla(overrides: Partial<ReglaParaClasificar> = {}): ReglaParaClasificar {
  return {
    _id: 'regla-1',
    cuentaContableId: 'cuenta-519',
    ladoAsiento: 'debe',
    prioridad: 100,
    activa: true,
    ...overrides,
  };
}

function movimiento(overrides: Partial<MovimientoParaClasificar> = {}): MovimientoParaClasificar {
  return { _id: 'mov-1', concepto: 'Comisión mantenimiento de cuenta', monto: -1200, ...overrides };
}

describe('clasificarMovimientos', () => {
  it('clasifica un movimiento cuando el patrón de texto matchea, sin distinguir mayúsculas', () => {
    const movimientos = [movimiento({ concepto: 'COMISION MANTENIMIENTO DE CUENTA' })];
    const reglas = [regla({ patronTexto: 'mantenimiento', cuentaContableId: 'cuenta-comisiones' })];

    const [resultado] = clasificarMovimientos(movimientos, reglas, CUENTA_BANCARIA_ID);

    expect(resultado.cuentaContableId).toBe('cuenta-comisiones');
    expect(resultado.reglaId).toBe('regla-1');
  });

  it('entre varias reglas que matchean, gana la de menor prioridad', () => {
    const movimientos = [movimiento({ concepto: 'Pago de servicios - Edenor' })];
    const reglas = [
      regla({
        _id: 'r-baja',
        patronTexto: 'servicios',
        prioridad: 200,
        cuentaContableId: 'cuenta-generica',
      }),
      regla({
        _id: 'r-alta',
        patronTexto: 'edenor',
        prioridad: 10,
        cuentaContableId: 'cuenta-edenor',
      }),
    ];

    const [resultado] = clasificarMovimientos(movimientos, reglas, CUENTA_BANCARIA_ID);

    expect(resultado.cuentaContableId).toBe('cuenta-edenor');
  });

  it('ignora las reglas inactivas', () => {
    const movimientos = [movimiento()];
    const reglas = [regla({ activa: false, cuentaContableId: 'cuenta-x' })];

    const [resultado] = clasificarMovimientos(movimientos, reglas, CUENTA_BANCARIA_ID);

    expect(resultado.cuentaContableId).toBeNull();
  });

  it('cuando ninguna regla matchea, usa la asignación manual por movimientoId si existe', () => {
    const movimientos = [movimiento({ _id: 'mov-42', concepto: 'Pago AFIP autonomos' })];
    const asignaciones = new Map([
      ['mov-42', { cuentaContableId: 'cuenta-afip', ladoAsiento: 'debe' as const }],
    ]);

    const [resultado] = clasificarMovimientos(movimientos, [], CUENTA_BANCARIA_ID, asignaciones);

    expect(resultado.cuentaContableId).toBe('cuenta-afip');
    expect(resultado.reglaId).toBeNull();
  });

  it('una asignación manual le gana siempre a una regla que matchea para el mismo movimiento — es la vía para rectificar una fila mal clasificada', () => {
    const movimientos = [movimiento({ _id: 'mov-42', concepto: 'Pago AFIP autonomos' })];
    const reglas = [regla({ patronTexto: 'afip', cuentaContableId: 'cuenta-regla' })];
    const asignaciones = new Map([
      ['mov-42', { cuentaContableId: 'cuenta-manual', ladoAsiento: 'haber' as const }],
    ]);

    const [resultado] = clasificarMovimientos(
      movimientos,
      reglas,
      CUENTA_BANCARIA_ID,
      asignaciones,
    );

    expect(resultado.cuentaContableId).toBe('cuenta-manual');
    expect(resultado.ladoAsiento).toBe('haber');
    expect(resultado.reglaId).toBeNull();
  });
});

describe('construirLineasAsiento', () => {
  it('sin saldos declarados, genera solo las líneas clasificadas, sin línea de banco', () => {
    const movimientos = [
      movimiento({ concepto: 'Comisión mantenimiento', monto: -1200, tipo: 'debito' }),
    ];
    const reglas = [
      regla({
        patronTexto: 'mantenimiento',
        cuentaContableId: 'cuenta-gastos',
        ladoAsiento: 'debe',
      }),
    ];

    const clasificados = clasificarMovimientos(movimientos, reglas, CUENTA_BANCARIA_ID);
    const lineas = construirLineasAsiento(clasificados, CUENTA_BANCO);

    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toMatchObject({
      cuentaContableId: 'cuenta-gastos',
      lado: 'debe',
      monto: 1200,
    });
  });

  it('agrega una única línea "plug" en la cuenta bancaria = saldoFinal - saldoInicial', () => {
    const movimientos = [
      movimiento({
        _id: 'mov-1',
        concepto: 'Comisión mantenimiento',
        monto: -1200,
        tipo: 'debito',
      }),
      movimiento({
        _id: 'mov-2',
        concepto: 'Transferencia recibida',
        monto: 50000,
        tipo: 'credito',
      }),
    ];
    const reglas = [
      regla({
        patronTexto: 'mantenimiento',
        cuentaContableId: 'cuenta-gastos',
        ladoAsiento: 'debe',
      }),
      regla({
        _id: 'regla-2',
        patronTexto: 'transferencia',
        cuentaContableId: 'cuenta-clientes',
        ladoAsiento: 'haber',
      }),
    ];

    const clasificados = clasificarMovimientos(movimientos, reglas, CUENTA_BANCARIA_ID);
    const lineas = construirLineasAsiento(clasificados, CUENTA_BANCO, 100000, 148800);

    const lineasBanco = lineas.filter((l) => l.cuentaContableId === CUENTA_BANCO);
    expect(lineasBanco).toHaveLength(1);
    expect(lineasBanco[0]).toMatchObject({ lado: 'debe', monto: 48800, movimientos: [] });
  });

  it('Total Debe = Total Haber deja de ser una tautología: si falta clasificar un movimiento con efecto neto, no cuadra', () => {
    const movimientos = [
      movimiento({
        _id: 'mov-1',
        concepto: 'Comisión mantenimiento',
        monto: -1200,
        tipo: 'debito',
      }),
      movimiento({
        _id: 'mov-2',
        concepto: 'Transferencia recibida',
        monto: 50000,
        tipo: 'credito',
      }),
    ];
    const reglas = [
      regla({
        patronTexto: 'mantenimiento',
        cuentaContableId: 'cuenta-gastos',
        ladoAsiento: 'debe',
      }),
    ];

    const clasificados = clasificarMovimientos(movimientos, reglas, CUENTA_BANCARIA_ID);
    const lineas = construirLineasAsiento(clasificados, CUENTA_BANCO, 100000, 148800);

    const totalDebe = lineas.filter((l) => l.lado === 'debe').reduce((acc, l) => acc + l.monto, 0);
    const totalHaber = lineas
      .filter((l) => l.lado === 'haber')
      .reduce((acc, l) => acc + l.monto, 0);

    expect(totalDebe).not.toBeCloseTo(totalHaber);
  });

  it('cuando todo está bien clasificado, el asiento cuadra exacto', () => {
    const movimientos = [
      movimiento({
        _id: 'mov-1',
        concepto: 'Comisión mantenimiento',
        monto: -1200,
        tipo: 'debito',
      }),
      movimiento({
        _id: 'mov-2',
        concepto: 'Transferencia recibida',
        monto: 50000,
        tipo: 'credito',
      }),
    ];
    const reglas = [
      regla({
        patronTexto: 'mantenimiento',
        cuentaContableId: 'cuenta-gastos',
        ladoAsiento: 'debe',
      }),
      regla({
        _id: 'regla-2',
        patronTexto: 'transferencia',
        cuentaContableId: 'cuenta-clientes',
        ladoAsiento: 'haber',
      }),
    ];

    const clasificados = clasificarMovimientos(movimientos, reglas, CUENTA_BANCARIA_ID);
    const lineas = construirLineasAsiento(clasificados, CUENTA_BANCO, 100000, 148800);

    const totalDebe = lineas.filter((l) => l.lado === 'debe').reduce((acc, l) => acc + l.monto, 0);
    const totalHaber = lineas
      .filter((l) => l.lado === 'haber')
      .reduce((acc, l) => acc + l.monto, 0);

    expect(totalDebe).toBeCloseTo(totalHaber);
  });

  it('replica el caso verificado del análisis forense: Credicoop 04-2025 (columnas clasificadas 1:1, banco como plug Debe)', () => {
    // Números reales del Excel "Movimientos Banco Credicoop Agrocentral 04-2025.xls":
    // SIRCREB=46.931,74 -> 1:1 a "11217 Retencion IIBB Banco"; PAGOS/TRANSF=5.260.000 -> 1:1 a "2111 Proveedores"
    // saldo: 27.568,30 -> 1.265.097,91 (delta +1.237.529,61) -> "1119 Banco Credicoop" Debe 1.237.529,61
    const movimientos = [
      movimiento({ _id: 'mov-sircreb', concepto: 'SIRCREB', monto: -46931.74, tipo: 'debito' }),
      movimiento({
        _id: 'mov-pago',
        concepto: 'PAGO PROVEEDOR SA',
        monto: -5260000,
        tipo: 'debito',
      }),
    ];
    const reglas = [
      regla({
        _id: 'r-sircreb',
        patronTexto: 'sircreb',
        cuentaContableId: 'cuenta-11217',
        ladoAsiento: 'debe',
      }),
      regla({
        _id: 'r-pago',
        patronTexto: 'proveedor',
        cuentaContableId: 'cuenta-2111',
        ladoAsiento: 'debe',
      }),
    ];

    const clasificados = clasificarMovimientos(movimientos, reglas, CUENTA_BANCARIA_ID);
    const lineas = construirLineasAsiento(
      clasificados,
      'cuenta-banco-credicoop',
      27568.3,
      1265097.91,
    );

    expect(lineas.find((l) => l.cuentaContableId === 'cuenta-11217')).toMatchObject({
      lado: 'debe',
      monto: 46931.74,
    });
    expect(lineas.find((l) => l.cuentaContableId === 'cuenta-2111')).toMatchObject({
      lado: 'debe',
      monto: 5260000,
    });
    const lineaBanco = lineas.find((l) => l.cuentaContableId === 'cuenta-banco-credicoop');
    expect(lineaBanco?.lado).toBe('debe');
    expect(lineaBanco?.monto).toBeCloseTo(1237529.61);
  });

  it('replica la fórmula REAL de Ley 25.413 de Galicia-Cookin: débito 100% a 539, crédito 66/34 entre 539 y 147', () => {
    // Extraído con Excel COM (solo lectura) de "Movimientos Banco Galicia Cookin 01-2025.xls",
    // celda Asientos!E9 (147): =+'ENE 24- DIC 24'!E113*0.34  — 34% SOLO del total de la columna
    // "Imp. Credito" (E113=275.197,614), nunca del débito. Asientos!E8 (539):
    // =+'ENE 24- DIC 24'!D113+'ENE 24- DIC 24'!E113-Asientos!E9 — el débito completo (D113=191.106,73)
    // más el 66% restante del crédito. No es un único % sobre el total combinado (esa fue la
    // aproximación incorrecta de la vuelta anterior) — son dos reglas distintas por patrón.
    const movimientos = [
      movimiento({
        _id: 'mov-deb',
        concepto: 'IMP. DEB. LEY 25413 GRAL.',
        monto: -191106.73,
        tipo: 'debito',
      }),
      movimiento({
        _id: 'mov-cre',
        concepto: 'IMP. CRE. LEY 25413',
        monto: -275197.614,
        tipo: 'debito',
      }),
    ];
    const reglaDebito = regla({
      _id: 'r-ley-debito',
      patronTexto: 'imp. deb. ley 25413',
      cuentaContableId: 'cuenta-539',
      ladoAsiento: 'debe',
    });
    const reglaCredito = regla({
      _id: 'r-ley-credito',
      patronTexto: 'imp. cre. ley 25413',
      cuentaContableId: 'cuenta-539',
      ladoAsiento: 'debe',
      cuentaContableSecundariaId: 'cuenta-147',
      porcentajeSecundario: 34,
    });

    const clasificados = clasificarMovimientos(
      movimientos,
      [reglaDebito, reglaCredito],
      CUENTA_BANCARIA_ID,
    );
    const lineas = construirLineasAsiento(clasificados, CUENTA_BANCO);

    const linea539 = lineas.find((l) => l.cuentaContableId === 'cuenta-539');
    const linea147 = lineas.find((l) => l.cuentaContableId === 'cuenta-147');

    expect(linea539?.monto).toBeCloseTo(372737.15, 1);
    expect(linea147?.monto).toBeCloseTo(93567.19, 1);
  });

  it('agrupa varios movimientos de la misma cuenta y lado en una sola línea, con trazabilidad', () => {
    const movimientos = [
      movimiento({
        _id: 'mov-1',
        concepto: 'Pago de servicios - Edenor',
        monto: -8500,
        tipo: 'debito',
      }),
      movimiento({
        _id: 'mov-2',
        concepto: 'Pago de servicios - Edenor',
        monto: -6200,
        tipo: 'debito',
      }),
    ];
    const reglas = [
      regla({ patronTexto: 'edenor', cuentaContableId: 'cuenta-servicios', ladoAsiento: 'debe' }),
    ];

    const clasificados = clasificarMovimientos(movimientos, reglas, CUENTA_BANCARIA_ID);
    const lineas = construirLineasAsiento(clasificados, CUENTA_BANCO);

    const lineaServicios = lineas.find((l) => l.cuentaContableId === 'cuenta-servicios');
    expect(lineaServicios?.monto).toBeCloseTo(14700);
    expect(lineaServicios?.movimientos).toHaveLength(2);
  });

  it('ignora los movimientos sin clasificar', () => {
    const movimientos = [movimiento({ concepto: 'Transferencia recibida', monto: 1000 })];
    const clasificados = clasificarMovimientos(movimientos, [], CUENTA_BANCARIA_ID);

    const lineas = construirLineasAsiento(clasificados, CUENTA_BANCO);

    expect(lineas).toHaveLength(0);
  });
});

describe('agruparMovimientosPorMes', () => {
  it('agrupa por "YYYY-MM" a partir de fecha "DD/MM/YY", preservando el orden de aparición de cada mes', () => {
    const movimientos = [
      movimiento({ _id: 'm1', fecha: '20/03/25' }),
      movimiento({ _id: 'm2', fecha: '05/04/25' }),
      movimiento({ _id: 'm3', fecha: '31/03/25' }),
    ];

    const grupos = agruparMovimientosPorMes(movimientos);

    expect(Array.from(grupos.keys())).toEqual(['2025-03', '2025-04']);
    expect(grupos.get('2025-03')).toHaveLength(2);
    expect(grupos.get('2025-04')).toHaveLength(1);
  });

  it('también reconoce fecha "DD/MM/YYYY"', () => {
    const movimientos = [movimiento({ fecha: '15/06/2024' })];
    const grupos = agruparMovimientosPorMes(movimientos);
    expect(Array.from(grupos.keys())).toEqual(['2024-06']);
  });

  it('los movimientos con fecha no parseable caen en un grupo "SIN_FECHA" separado', () => {
    const movimientos = [movimiento({ fecha: 'fecha inválida' }), movimiento({ fecha: undefined })];
    const grupos = agruparMovimientosPorMes(movimientos);
    expect(Array.from(grupos.keys())).toEqual(['SIN_FECHA']);
    expect(grupos.get('SIN_FECHA')).toHaveLength(2);
  });
});

describe('construirAsientosMensuales', () => {
  it('un extracto de un solo mes arma un único asiento, igual que construirLineasAsiento', () => {
    const movimientos = [
      movimiento({
        _id: 'mov-1',
        concepto: 'Comisión mantenimiento',
        monto: -1200,
        tipo: 'debito',
        fecha: '10/04/25',
        saldoCalculado: 98800,
      }),
    ];
    const reglas = [
      regla({
        patronTexto: 'mantenimiento',
        cuentaContableId: 'cuenta-gastos',
        ladoAsiento: 'debe',
      }),
    ];

    const asientos = construirAsientosMensuales(
      movimientos,
      reglas,
      CUENTA_BANCARIA_ID,
      CUENTA_BANCO,
      100000,
    );

    expect(asientos).toHaveLength(1);
    expect(asientos[0].periodo).toBe('2025-04');
    expect(asientos[0].saldoInicial).toBe(100000);
    expect(asientos[0].saldoFinal).toBe(98800);
    const lineaGastos = asientos[0].lineas.find((l) => l.cuentaContableId === 'cuenta-gastos');
    expect(lineaGastos?.monto).toBeCloseTo(1200);
  });

  it('un extracto que cruza dos meses arma dos asientos, cada uno con su propio saldo inicial/final encadenado', () => {
    const movimientos = [
      movimiento({
        _id: 'mov-marzo',
        concepto: 'Gasto de marzo',
        monto: -300,
        tipo: 'debito',
        fecha: '20/03/25',
        saldoCalculado: 700,
      }),
      movimiento({
        _id: 'mov-abril',
        concepto: 'Gasto de abril',
        monto: -200,
        tipo: 'debito',
        fecha: '05/04/25',
        saldoCalculado: 500,
      }),
    ];
    const reglas = [
      regla({ patronTexto: 'gasto', cuentaContableId: 'cuenta-gastos', ladoAsiento: 'debe' }),
    ];

    const asientos = construirAsientosMensuales(
      movimientos,
      reglas,
      CUENTA_BANCARIA_ID,
      CUENTA_BANCO,
      1000,
    );

    expect(asientos).toHaveLength(2);

    expect(asientos[0].periodo).toBe('2025-03');
    expect(asientos[0].saldoInicial).toBe(1000);
    expect(asientos[0].saldoFinal).toBe(700);
    const lineaBancoMarzo = asientos[0].lineas.find((l) => l.cuentaContableId === CUENTA_BANCO);
    expect(lineaBancoMarzo).toMatchObject({ lado: 'haber', monto: 300 });

    expect(asientos[1].periodo).toBe('2025-04');
    // El saldo inicial de abril es el saldo final de marzo, no el saldo inicial del extracto.
    expect(asientos[1].saldoInicial).toBe(700);
    expect(asientos[1].saldoFinal).toBe(500);
    const lineaBancoAbril = asientos[1].lineas.find((l) => l.cuentaContableId === CUENTA_BANCO);
    expect(lineaBancoAbril).toMatchObject({ lado: 'haber', monto: 200 });
  });
});
