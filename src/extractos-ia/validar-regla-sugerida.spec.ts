import { validarReglaSugerida } from './extractos-ia.processor';

const movimientos = [
  { concepto: 'Pago comercios getnet nro.liq. 00004473', tipo: 'credito' },
  { concepto: 'Pago comercios getnet nro.liq. 00023406', tipo: 'debito' },
  { concepto: 'Pago de servicios Movistar: 0420013972984', tipo: 'debito' },
];

describe('validarReglaSugerida', () => {
  it('toma tipo y lado de los movimientos reales, no de lo que dijo la IA', () => {
    const resultado = validarReglaSugerida(
      { patronTexto: 'Pago de servicios Movistar', cuentaCodigo: '519', ladoAsiento: 'haber' },
      movimientos,
      [],
    );
    expect(resultado).toEqual({ tipoMovimiento: 'debito', ladoAsiento: 'debe' });
  });

  it('descarta un patrón que no aparece en ningún movimiento del extracto', () => {
    expect(
      validarReglaSugerida(
        { patronTexto: 'Cablevision', cuentaCodigo: '519', ladoAsiento: 'debe' },
        movimientos,
        [],
      ),
    ).toBeNull();
  });

  it('descarta un patrón que mezcla débitos y créditos', () => {
    expect(
      validarReglaSugerida(
        { patronTexto: 'Pago comercios', cuentaCodigo: '132', ladoAsiento: 'haber' },
        movimientos,
        [],
      ),
    ).toBeNull();
  });

  it('descarta si ya hay una regla activa para el mismo texto y tipo', () => {
    expect(
      validarReglaSugerida(
        { patronTexto: 'pago de servicios  movistar', cuentaCodigo: '519', ladoAsiento: 'debe' },
        movimientos,
        [{ patronTexto: 'Pago de servicios Movistar', tipoMovimiento: 'debito' }],
      ),
    ).toBeNull();
  });
});
