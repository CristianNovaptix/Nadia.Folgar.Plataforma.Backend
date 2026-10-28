import {
  MAX_CARACTERES_POR_TRAMO,
  armarTramos,
  combinarSaldos,
  esCortePorLargo,
  mapConConcurrencia,
  unificarReglasSugeridas,
} from './extraccion-por-tramos';

describe('armarTramos', () => {
  it('un extracto corto queda en una sola parte con el texto completo', () => {
    expect(armarTramos('texto corto', ['texto', 'corto'])).toEqual([{ texto: 'texto corto' }]);
  });

  it('un extracto largo se parte entre páginas, sin pasar el tope por parte', () => {
    const paginas = Array.from({ length: 10 }, (_, i) => `pag${i}\n` + 'x'.repeat(5000));
    const tramos = armarTramos(paginas.join('\n\n'), paginas);

    expect(tramos.length).toBeGreaterThan(1);
    for (const tramo of tramos) {
      expect(tramo.texto.length).toBeLessThanOrEqual(MAX_CARACTERES_POR_TRAMO + 10);
    }
    expect(tramos.map((t) => t.texto).join('\n\n')).toBe(paginas.join('\n\n'));
    expect(tramos[0].continuacion?.startsWith('pag2')).toBe(true);
    expect(tramos[tramos.length - 1].continuacion).toBeUndefined();
  });
});

describe('combinarSaldos', () => {
  const r = (movs: number, inicial?: number, final?: number) => ({
    exitoso: true,
    movimientos: Array.from({ length: movs }, () => ({ fecha: '', concepto: '', monto: 1 })),
    reglasSugeridas: [],
    saldoInicialDeclarado: inicial,
    saldoFinalDeclarado: final,
  });

  it('toma el inicial del principio y el final del cierre, salteando partes sin movimientos', () => {
    expect(combinarSaldos([r(0), r(5, 100), r(5, 999, 888), r(5, undefined, 200), r(0)])).toEqual({
      saldoInicialDeclarado: 100,
      saldoFinalDeclarado: 200,
    });
  });

  it('no toma un saldo de una parte posterior a la primera con movimientos', () => {
    expect(combinarSaldos([r(5), r(5, 999)]).saldoInicialDeclarado).toBeUndefined();
  });

  it('el saldo final se toma aunque después vengan partes con anexos', () => {
    expect(combinarSaldos([r(5, 100), r(5, undefined, 200), r(3)]).saldoFinalDeclarado).toBe(200);
  });
});

describe('esCortePorLargo', () => {
  const fallo = (mensaje: string) => ({
    exitoso: false,
    movimientos: [],
    reglasSugeridas: [],
    mensaje,
  });

  it('reconoce los cortes por largo de OpenAI y Anthropic, no otros errores', () => {
    expect(
      esCortePorLargo(fallo('Could not parse response content as the length limit was reached')),
    ).toBe(true);
    expect(
      esCortePorLargo(
        fallo('La IA no devolvió un resultado estructurado válido (stop_reason: max_tokens).'),
      ),
    ).toBe(true);
    expect(esCortePorLargo(fallo('El proveedor de IA rechazó procesar este extracto.'))).toBe(
      false,
    );
  });
});

describe('armarTramos forzado', () => {
  it('parte un extracto mediano cuando se fuerza', () => {
    const paginas = ['a'.repeat(9000), 'b'.repeat(9000)];
    expect(armarTramos(paginas.join('\n\n'), paginas)).toHaveLength(1);
    expect(armarTramos(paginas.join('\n\n'), paginas, true)).toHaveLength(2);
  });
});

describe('unificarReglasSugeridas', () => {
  const regla = (patronTexto: string, cuentaCodigo: string) => ({
    patronTexto,
    cuentaCodigo,
    ladoAsiento: 'debe' as const,
    tipoMovimiento: 'debito' as const,
  });

  it('no repite el mismo patrón y descarta los que se contradicen', () => {
    const unificadas = unificarReglasSugeridas([
      [regla('Comision', '1.1'), regla('Movistar', '5.1')],
      [regla('comisión', '1.1'), regla('Movistar', '5.2')],
    ]);
    expect(unificadas).toEqual([regla('Comision', '1.1')]);
  });
});

describe('mapConConcurrencia', () => {
  it('respeta el límite y conserva el orden', async () => {
    let enCurso = 0;
    let maximo = 0;
    const resultado = await mapConConcurrencia([5, 1, 3, 2, 4], 2, async (n) => {
      enCurso += 1;
      maximo = Math.max(maximo, enCurso);
      await new Promise((resolve) => setTimeout(resolve, n));
      enCurso -= 1;
      return n * 10;
    });
    expect(resultado).toEqual([50, 10, 30, 20, 40]);
    expect(maximo).toBe(2);
  });
});
