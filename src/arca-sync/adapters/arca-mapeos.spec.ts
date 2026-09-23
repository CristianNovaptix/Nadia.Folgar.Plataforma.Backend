import {
  mapearComprobante,
  mapearDeudas,
  mapearVencimientosCtacte,
  mapearPresentaciones,
  mapearVencimientos,
  mapearVeps,
  presentacionesAceptadas,
  type PortalVencimiento,
  type SetiPresentacion,
} from './arca-mapeos';

// Respuestas con la misma forma que devuelve ARCA (datos de ejemplo).
const agenda: PortalVencimiento[] = [
  {
    idImpuesto: 11,
    periodo: 202500,
    anticipoCuota: 0,
    tipoOperacion: 'PRESENTACION',
    vencimiento: Date.parse('2026-10-14T03:00:00Z'),
    formularios: '711',
    descImpuesto: 'IMP. A LAS GANANCIAS LEY 20628 - PERSONAS EXISTENCIA VISIBLE',
    descConcepto: 'DECLARACIÓN JURADA',
  },
  {
    idImpuesto: 11,
    periodo: 202600,
    anticipoCuota: 1,
    tipoOperacion: 'PAGO',
    vencimiento: Date.parse('2026-09-25T03:00:00Z'),
    descImpuesto: 'IMP. A LAS GANANCIAS LEY 20628 - PERSONAS EXISTENCIA VISIBLE',
    descConcepto: 'ANTICIPOS',
  },
  {
    idImpuesto: 308,
    periodo: 202608,
    anticipoCuota: 0,
    tipoOperacion: 'PAGO',
    vencimiento: Date.parse('2026-09-10T03:00:00Z'),
    descImpuesto: 'APORTES DE LA SEGURIDAD SOCIAL (AUTONOMOS)',
    descConcepto: 'DECLARACIÓN JURADA',
  },
];
const presentadas: SetiPresentacion[] = [
  { estado: 1, formulario: 'F711 v2800', periodo: '2025-00', fechaPresentacion: '2026-09-18 14:44:27.000' },
  { estado: 1, formulario: 'F2002 v100', periodo: '2026-08', fechaPresentacion: '2026-09-15 10:00:00.000' },
];
const hoy = new Date('2026-09-22T12:00:00Z');

describe('arca-mapeos', () => {
  it('vencimientos: marca cumplido si la DDJJ ya se presentó, y próximo/vencido por fecha', () => {
    const v = mapearVencimientos(agenda, presentacionesAceptadas(presentadas), hoy);

    expect(v.map((x) => [x.periodo, x.estado])).toEqual([
      ['2026-08', 'vencido'],
      ['2026', 'pendiente'],
      ['2025', 'cumplido'],
    ]);
    expect(v[1].concepto).toBe('Anticipos — cuota 1 (pago)');
    expect(v[1].impuesto).toBe('Imp. a las ganancias ley 20628 - personas existencia visible');
  });

  it('presentaciones: presentadas con impuesto por formulario y pendientes de la agenda', () => {
    const otraAgenda = [...agenda, { ...agenda[0], periodo: 202600, formularios: '711' }];
    const p = mapearPresentaciones(presentadas, [], otraAgenda, presentacionesAceptadas(presentadas));

    expect(p[0]).toMatchObject({ estado: 'pendiente', periodo: '2026', formulario: 'F711' });
    expect(p.filter((x) => x.estado === 'presentada').map((x) => [x.impuesto, x.periodo])).toEqual([
      ['Imp. a las ganancias ley 20628 - personas existencia visible', '2025'],
      ['IVA', '2026-08'],
    ]);
    expect(p.find((x) => x.periodo === '2025')?.fechaPresentacion).toBe('2026-09-18T17:44:27.000Z');
  });

  it('deudas: saldo, intereses, período y si está vencida (Cuentas Tributarias)', () => {
    const [deuda] = mapearDeudas(
      [
        {
          impuestoView: '30 - IVA',
          conceptoView: '19 - DECLARACIÓN JURADA',
          subconceptoView: '19 - DECLARACIÓN JURADA',
          periodoFiscal: 202406,
          anticipocuota: 0,
          fechaVencimiento: '2024-09-18 00:00:00',
          importe: 481930.41,
          importeInteresesResarcitorios: 233184.34,
          importeInteresesPunitorios: 0,
        },
      ],
      hoy,
    );
    expect(deuda).toMatchObject({
      impuesto: '30 - IVA',
      periodo: '2024-06',
      saldo: 481930.41,
      interesesResarcitorios: 233184.34,
      vencida: true,
      fechaVencimiento: '2024-09-18T03:00:00.000Z',
    });
  });

  it('vencimientos de un representado (Cuentas Tributarias), período 20260900 → 2026-09', () => {
    const [v] = mapearVencimientosCtacte(
      [
        {
          tipoOperacion: 'Presentacion y Pago',
          fechaVencimiento: '2026-10-19 00:00:00',
          periodoFiscal: 20260900,
          descImpuesto: 'IVA',
          descConcepto: 'DECLARACIÓN JURADA',
          anticipoCuota: 0,
        },
      ],
      hoy,
    );
    expect(v).toMatchObject({ impuesto: 'IVA', periodo: '2026-09', estado: 'proximo' });
  });

  it('VEP: pagado si tiene fecha de pago', () => {
    const [vep] = mapearVeps([
      { estado: 2, nroVep: 1567224054, importe: 7600, descripcion: 'COMEXT', fechaDePago: '2026-01-05 13:29:43.0' },
    ]);
    expect(vep).toMatchObject({ numero: '1567224054', impuesto: 'COMEXT', importe: 7600, estado: 'pagado' });
  });

  it('comprobantes: emitidos y recibidos toman importe e IVA del final de la fila', () => {
    const clases = new Map([['1', 'Factura A']]);
    const emitido = [
      '03/06/2026', '1', null, '3', '448', '448', null, null, '86228187794967', null, '80', '30708198397',
      'PRIMA PRODUCTORA ASESORA DE SEGUROS S A', '1', '$', ...Array(14).fill(null), '471124.5', null,
      '2243450', null, null, null, null, null, '2243450', null, '0', null, '0', null, '0', null, '471124.5', null,
      '2714574.5', null,
    ];
    const recibido = [
      '01/06/2026', '1', null, '4', '746371', '746371', null, null, '86227968303576', null, '80', '30500036911',
      'COMPAÑIA DE SEGUROS LA MERCANTIL ANDINA S.A.', null, '80', '30715657151', '1', '$', ...Array(14).fill(null),
      '2308.67', null, '10993.65', null, null, null, null, null, '10993.65', null, '120.93', null, '0', null, '0',
      null, '2308.67', null, '14324.73', null,
    ];

    expect(mapearComprobante(emitido, 'venta', clases)).toMatchObject({
      tipo: 'venta', clase: 'Factura A', periodo: '2026-06', puntoVenta: 3, numero: '448',
      cuitContraparte: '30708198397', importeTotal: 2714574.5, iva: 471124.5,
    });
    expect(mapearComprobante(recibido, 'compra', clases)).toMatchObject({
      tipo: 'compra', cuitContraparte: '30500036911', importeTotal: 14324.73, iva: 2308.67,
    });
  });
});

describe('arca-mapeos — DDJJ faltantes', () => {
  it('no duplica la misma DDJJ faltante que informan SETI y Cuentas Tributarias', () => {
    const ctacte = {
      impuesto: 103,
      descImpuesto: 'REGIMENES DE INFORMACION',
      concepto: 984,
      descConcepto: 'PARTICIPACIONES SOCIETARIAS',
      periodoFiscal: 2024,
      fechaVencimiento: '2025-07-28 00:00:00',
    };
    const seti = {
      impuesto: { codigo: 103, descripcion: 'REGIMENES DE INFORMACIÓN' },
      concepto: 984,
      periodoFiscal: 202400,
      fechaVencimiento: 1753671600000,
    };
    const p = mapearPresentaciones([], [ctacte, seti], [], new Set());

    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({
      impuesto: 'Regimenes de informacion — Participaciones societarias',
      periodo: '2024',
      fechaVencimiento: '2025-07-28T03:00:00.000Z',
      estado: 'pendiente',
    });
  });
});
