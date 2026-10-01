import { ExtractoDeteccionService } from './extracto-deteccion.service';

describe('ExtractoDeteccionService', () => {
  const service = new ExtractoDeteccionService();

  describe('detección de CUIT', () => {
    it('detecta un CUIT con guiones cerca de la palabra "CUIT"', () => {
      const texto =
        'Banco XYZ\nTitular: Panadería López SRL\nCUIT: 30-71234567-8\nResumen de cuenta';
      expect(service.detectar(texto).cuitDetectado).toBe('30-71234567-8');
    });

    it('detecta un CUIT sin guiones y lo normaliza', () => {
      const texto = 'CUIT 30712345678 - Cuenta Corriente en Pesos';
      expect(service.detectar(texto).cuitDetectado).toBe('30-71234567-8');
    });

    it('prioriza el CUIT cercano a la palabra clave por sobre otro número de 11 dígitos lejano', () => {
      const texto =
        'Comprobante N° 20123456789\n'.repeat(3) +
        'Otros datos.\n'.repeat(5) +
        'CUIT: 27-98765432-1\nFin del encabezado';
      expect(service.detectar(texto).cuitDetectado).toBe('27-98765432-1');
    });

    it('cae al primer CUIT con formato válido si no hay ninguno cerca de la palabra "CUIT"', () => {
      const texto = 'Extracto bancario sin la palabra clave. Referencia: 20-12345678-3.';
      expect(service.detectar(texto).cuitDetectado).toBe('20-12345678-3');
    });

    it('no detecta nada si no hay ningún número con formato de CUIT', () => {
      const texto = 'Extracto bancario sin ningún identificador reconocible.';
      expect(service.detectar(texto).cuitDetectado).toBeUndefined();
    });
  });

  describe('detección de banco', () => {
    it('elige el banco más mencionado, no uno que aparece en un movimiento', () => {
      const texto =
        'Banco Provincia\nExtracto de Cuenta\nDep: BANCO MACRO\nBanco Pcia - Cta cte\nProvincia Net';
      expect(service.detectar(texto).bancoDetectado?.nombre).toBe('Provincia');
    });

    it('no detecta banco si no se menciona ninguno conocido', () => {
      expect(service.detectar('Resumen de cuenta').bancoDetectado).toBeUndefined();
    });
  });

  describe('detección de período', () => {
    it('toma el mes de la fecha "Hasta" (Santander, año de 2 dígitos)', () => {
      const texto = 'Período\nDesde: 29/06/24\nHasta: 31/07/24\n01/07/24 Mov\n02/06/24 Mov';
      expect(service.detectar(texto)).toMatchObject({
        periodoDetectado: '2024-07',
        fechaHastaDetectada: '2024-07-31',
      });
    });

    it('toma el "al:" de un rango "del: ... al: ..." (Credicoop)', () => {
      const texto = 'Resumen: 25004 del: 01/04/2025 al: 30/04/2025 Cta. 191';
      expect(service.detectar(texto).periodoDetectado).toBe('2025-04');
    });

    it('toma el final de "PERIODO (dd-mm-yyyy/dd-mm-yyyy)" (Provincia)', () => {
      const texto = 'COM. MANT. POR 034 MOV. PERIODO (27-03-2025/28-04-2025) -37400.00';
      expect(service.detectar(texto).periodoDetectado).toBe('2025-04');
    });

    it('toma el segundo extremo de "ENTRE EL ... Y EL ..." (Galicia)', () => {
      const texto = 'PERIODO COMPRENDIDO ENTRE EL 30-12-2024 Y EL 31-01-2025';
      expect(service.detectar(texto).periodoDetectado).toBe('2025-01');
    });

    it('no toma un "HASTA" sin dos puntos de la descripción de un movimiento', () => {
      const texto =
        'COMISION DESDE 01-03-2025 HASTA 31-03-2025\n10/04/2025 a\n11/04/2025 b\n12/04/2025 c';
      expect(service.detectar(texto).periodoDetectado).toBe('2025-04');
    });

    it('detecta el período por la mención explícita "Período ... dd/mm/yyyy"', () => {
      const texto = 'Resumen de cuenta\nPeríodo: 01/08/2026 al 31/08/2026\nSaldo inicial: 100000';
      expect(service.detectar(texto).periodoDetectado).toBe('2026-08');
    });

    it('detecta el período por la mención explícita con mes en español', () => {
      const texto = 'Resumen correspondiente al Período de Agosto 2026';
      expect(service.detectar(texto).periodoDetectado).toBe('2026-08');
    });

    it('cae a la moda de fechas repetidas si no hay mención explícita de período', () => {
      const texto = [
        'Movimientos:',
        '01/08/2026 Transferencia recibida 150000',
        '03/08/2026 Pago de servicios -8500',
        '15/08/2026 Transferencia recibida 95000',
      ].join('\n');
      expect(service.detectar(texto).periodoDetectado).toBe('2026-08');
    });

    it('no detecta período con una única fecha suelta (evita adivinar sin confianza)', () => {
      const texto = 'Comprobante emitido el 05/03/2026 por un pago aislado.';
      expect(service.detectar(texto).periodoDetectado).toBeUndefined();
    });

    it('no detecta nada si no hay ninguna fecha en el texto', () => {
      const texto = 'Extracto sin fechas reconocibles.';
      expect(service.detectar(texto).periodoDetectado).toBeUndefined();
    });
  });
});
