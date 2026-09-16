import { Types } from 'mongoose';
import { CatedralFileAdapter } from './catedral-file.adapter';
import { ExtractosIaService } from '../../extractos-ia/extractos-ia.service';
import { AsientoContableService } from '../../asientos-contables/asiento-contable.service';

describe('CatedralFileAdapter', () => {
  const estudioId = new Types.ObjectId();
  const extractoId = new Types.ObjectId().toString();

  const extractosIaServiceMock = {
    obtenerDocumentoCompleto: jest.fn(),
  } as unknown as ExtractosIaService;

  const asientoContableServiceMock = {
    construirAsiento: jest.fn(),
  } as unknown as AsientoContableService;

  let adapter: CatedralFileAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new CatedralFileAdapter(extractosIaServiceMock, asientoContableServiceMock);
  });

  it('no genera archivo y devuelve exitoso=false cuando algún mes no cuadra', async () => {
    (extractosIaServiceMock.obtenerDocumentoCompleto as jest.Mock).mockResolvedValue({
      periodo: '2025-04',
    });
    (asientoContableServiceMock.construirAsiento as jest.Mock).mockResolvedValue({
      meses: [
        {
          periodo: '2025-04',
          lineas: [],
          totalDebe: 100,
          totalHaber: 50,
          cuadra: false,
          sinClasificar: [],
        },
      ],
      banco: 'Credicoop',
    });

    const resultado = await adapter.exportarAsientoContable({
      extractoId,
      estudioId: estudioId.toString(),
    });

    expect(resultado.exitoso).toBe(false);
    expect(resultado.archivo).toBeUndefined();
    expect(resultado.validacion?.meses[0]).toMatchObject({ periodo: '2025-04', cuadra: false });
  });

  it('no genera archivo cuando algún mes tiene movimientos sin clasificar, aunque el total dé igual', async () => {
    (extractosIaServiceMock.obtenerDocumentoCompleto as jest.Mock).mockResolvedValue({
      periodo: '2025-04',
    });
    (asientoContableServiceMock.construirAsiento as jest.Mock).mockResolvedValue({
      meses: [
        {
          periodo: '2025-04',
          lineas: [],
          totalDebe: 0,
          totalHaber: 0,
          cuadra: true,
          sinClasificar: [{ movimientoId: 'm1', concepto: 'Pago sin regla', monto: 500 }],
        },
      ],
      banco: 'Credicoop',
    });

    const resultado = await adapter.exportarAsientoContable({
      extractoId,
      estudioId: estudioId.toString(),
    });

    expect(resultado.exitoso).toBe(false);
    expect(resultado.validacion?.meses[0].sinClasificar).toHaveLength(1);
  });

  it('rechaza el export completo si UN mes falla, aunque otros meses estén bien (extracto de varios meses)', async () => {
    (extractosIaServiceMock.obtenerDocumentoCompleto as jest.Mock).mockResolvedValue({});
    (asientoContableServiceMock.construirAsiento as jest.Mock).mockResolvedValue({
      meses: [
        {
          periodo: '2025-03',
          lineas: [],
          totalDebe: 100,
          totalHaber: 100,
          cuadra: true,
          sinClasificar: [],
        },
        {
          periodo: '2025-04',
          lineas: [],
          totalDebe: 100,
          totalHaber: 50,
          cuadra: false,
          sinClasificar: [],
        },
      ],
      banco: 'Galicia',
    });

    const resultado = await adapter.exportarAsientoContable({
      extractoId,
      estudioId: estudioId.toString(),
    });

    expect(resultado.exitoso).toBe(false);
    expect(resultado.mensaje).toContain('2025-04');
  });

  it('genera el archivo .xlsx con un bloque por mes cuando todos los meses cuadran y no quedan movimientos sin clasificar', async () => {
    (extractosIaServiceMock.obtenerDocumentoCompleto as jest.Mock).mockResolvedValue({
      periodo: '2025-04',
    });
    (asientoContableServiceMock.construirAsiento as jest.Mock).mockResolvedValue({
      meses: [
        {
          periodo: '2025-04',
          lineas: [
            {
              cuentaContableId: 'c1',
              codigo: '519',
              nombre: 'Gastos Bancarios',
              lado: 'debe',
              monto: 1200,
            },
            {
              cuentaContableId: 'c2',
              codigo: '1119',
              nombre: 'Banco Credicoop',
              lado: 'haber',
              monto: 1200,
            },
          ],
          totalDebe: 1200,
          totalHaber: 1200,
          cuadra: true,
          sinClasificar: [],
        },
      ],
      banco: 'Credicoop',
    });

    const resultado = await adapter.exportarAsientoContable({
      extractoId,
      estudioId: estudioId.toString(),
    });

    expect(resultado.exitoso).toBe(true);
    expect(resultado.archivo?.nombreArchivo).toBe('Asiento Credicoop 2025-04.xlsx');
    expect(resultado.archivo?.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(resultado.archivo?.contenidoBase64.length).toBeGreaterThan(0);
  });
});
