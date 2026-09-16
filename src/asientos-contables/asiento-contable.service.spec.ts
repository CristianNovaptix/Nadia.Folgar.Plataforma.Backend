import { Types } from 'mongoose';
import { AsientoContableService } from './asiento-contable.service';
import { CuentasBancariasService } from '../cuentas-bancarias/cuentas-bancarias.service';
import { ExtractoBancarioDocument } from '../extractos-ia/schemas/extracto-bancario.schema';

describe('AsientoContableService', () => {
  const estudioId = new Types.ObjectId();
  const clienteId = new Types.ObjectId();
  const cuentaBancariaId = new Types.ObjectId();

  const cuentaGastos = { _id: new Types.ObjectId(), codigo: '519', nombre: 'Gastos Bancarios' };
  const cuentaBanco = { _id: new Types.ObjectId(), codigo: '1119', nombre: 'Banco Credicoop' };

  const reglaModelMock = { find: jest.fn() };
  const cuentaContableModelMock = { find: jest.fn() };
  const cuentasBancariasServiceMock = { findOne: jest.fn() } as unknown as CuentasBancariasService;

  let service: AsientoContableService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AsientoContableService(
      reglaModelMock as any,
      cuentaContableModelMock as any,
      cuentasBancariasServiceMock,
    );
    (cuentasBancariasServiceMock.findOne as jest.Mock).mockResolvedValue({
      banco: 'Credicoop',
      cuentaContableId: cuentaBanco._id,
    });
    cuentaContableModelMock.find.mockReturnValue({
      exec: jest.fn().mockResolvedValue([cuentaGastos, cuentaBanco]),
    });
  });

  function extracto(overrides: Partial<ExtractoBancarioDocument> = {}): ExtractoBancarioDocument {
    return {
      _id: new Types.ObjectId(),
      clienteId,
      cuentaBancariaId,
      periodo: '2025-04',
      saldoInicialDeclarado: 27568.3,
      movimientos: [
        {
          _id: new Types.ObjectId(),
          concepto: 'SIRCREB',
          monto: -46931.74,
          tipo: 'debito',
          fecha: '10/04/25',
        },
        {
          _id: new Types.ObjectId(),
          concepto: 'Transferencia recibida',
          monto: 1237529.61 + 46931.74,
          tipo: 'credito',
          fecha: '15/04/25',
          saldoCalculado: 1265097.91,
        },
      ],
      ...overrides,
    } as unknown as ExtractoBancarioDocument;
  }

  it('resuelve código y nombre de cuenta, y arma el plug del banco con el saldo del mes', async () => {
    reglaModelMock.find.mockReturnValue({
      exec: jest.fn().mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          cuentaBancariaId: undefined,
          patronTexto: 'sircreb',
          cuentaContableId: cuentaGastos._id,
          ladoAsiento: 'debe',
          prioridad: 100,
          activa: true,
        },
      ]),
    });

    const doc = extracto();
    const resultado = await service.construirAsiento(doc, estudioId);

    expect(resultado.meses).toHaveLength(1);
    const mes = resultado.meses[0];
    expect(mes.periodo).toBe('2025-04');

    const lineaGastos = mes.lineas.find((l) => l.cuentaContableId === cuentaGastos._id.toString());
    expect(lineaGastos).toMatchObject({
      codigo: '519',
      nombre: 'Gastos Bancarios',
      lado: 'debe',
      monto: 46931.74,
    });

    const lineaBanco = mes.lineas.find((l) => l.cuentaContableId === cuentaBanco._id.toString());
    expect(lineaBanco).toMatchObject({ codigo: '1119', lado: 'debe' });
    expect(resultado.banco).toBe('Credicoop');
  });

  it('sin reglas activas, todos los movimientos quedan sin clasificar y el mes no cuadra', async () => {
    reglaModelMock.find.mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });

    const resultado = await service.construirAsiento(extracto(), estudioId);

    expect(resultado.meses).toHaveLength(1);
    expect(resultado.meses[0].sinClasificar).toHaveLength(2);
    expect(resultado.meses[0].cuadra).toBe(false);
  });

  it('rechaza una asignación manual que apunta a una cuenta contable de otro cliente', async () => {
    reglaModelMock.find.mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });
    const doc = extracto();
    const cuentaAjena = new Types.ObjectId().toString();

    await expect(
      service.construirAsiento(doc, estudioId, [
        {
          movimientoId: doc.movimientos[0]._id!.toString(),
          cuentaContableId: cuentaAjena,
          ladoAsiento: 'debe' as any,
        },
      ]),
    ).rejects.toThrow('no pertenece al plan de cuentas del cliente');
  });

  it('sin saldo de cierre en el mes, cuadra=false aunque todo esté clasificado', async () => {
    reglaModelMock.find.mockReturnValue({
      exec: jest.fn().mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          patronTexto: 'sircreb',
          cuentaContableId: cuentaGastos._id,
          ladoAsiento: 'debe',
          prioridad: 100,
          activa: true,
        },
        {
          _id: new Types.ObjectId(),
          patronTexto: 'transferencia',
          cuentaContableId: cuentaGastos._id,
          ladoAsiento: 'debe',
          prioridad: 100,
          activa: true,
        },
      ]),
    });

    const doc = extracto({
      saldoInicialDeclarado: undefined,
      movimientos: [
        {
          _id: new Types.ObjectId(),
          concepto: 'SIRCREB',
          monto: -46931.74,
          tipo: 'debito',
          fecha: '10/04/25',
        },
        {
          _id: new Types.ObjectId(),
          concepto: 'Transferencia recibida',
          monto: 1237529.61 + 46931.74,
          tipo: 'credito',
          fecha: '15/04/25',
        },
      ],
    } as any);
    const resultado = await service.construirAsiento(doc, estudioId);

    expect(resultado.meses[0].sinClasificar).toHaveLength(0);
    expect(resultado.meses[0].cuadra).toBe(false);
  });

  it('un extracto que cruza dos meses arma dos asientos, cada uno con su propio saldo y balance', async () => {
    reglaModelMock.find.mockReturnValue({
      exec: jest.fn().mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          patronTexto: 'gasto',
          cuentaContableId: cuentaGastos._id,
          ladoAsiento: 'debe',
          prioridad: 100,
          activa: true,
        },
      ]),
    });

    const doc = extracto({
      saldoInicialDeclarado: 1000,
      movimientos: [
        {
          _id: new Types.ObjectId(),
          concepto: 'Gasto de marzo',
          monto: -300,
          tipo: 'debito',
          fecha: '20/03/25',
          saldoCalculado: 700,
        },
        {
          _id: new Types.ObjectId(),
          concepto: 'Gasto de abril',
          monto: -200,
          tipo: 'debito',
          fecha: '05/04/25',
          saldoCalculado: 500,
        },
      ],
    } as any);

    const resultado = await service.construirAsiento(doc, estudioId);

    expect(resultado.meses).toHaveLength(2);
    expect(resultado.meses[0].periodo).toBe('2025-03');
    expect(resultado.meses[1].periodo).toBe('2025-04');

    // Marzo: plug = 700 - 1000 = -300 (Haber), cuadra con el gasto de 300 en Debe.
    expect(resultado.meses[0].cuadra).toBe(true);
    // Abril: plug = 500 - 700 = -200 (Haber), cuadra con el gasto de 200 en Debe.
    expect(resultado.meses[1].cuadra).toBe(true);
  });
});
