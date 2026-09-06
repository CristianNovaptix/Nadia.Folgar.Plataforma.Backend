import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Job } from 'bullmq';
import { ExtractosIaProcessor, ProcesarExtractoJobData } from './extractos-ia.processor';
import { AiExtractionStubAdapter } from './adapters/ai-extraction-stub.adapter';
import { AnthropicExtractionAdapter } from './adapters/anthropic-extraction.adapter';
import { OpenAiExtractionAdapter } from './adapters/openai-extraction.adapter';
import {
  EstadoExtracto,
  ExtractoBancario,
  TipoMovimiento,
  ValidacionSaldo,
} from './schemas/extracto-bancario.schema';
import { PdfTextExtractorService } from './pdf-text-extractor.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PlanCuentasService } from '../plan-cuentas/plan-cuentas.service';
import { ReglasClasificacionService } from '../reglas-clasificacion/reglas-clasificacion.service';
import { AiProviderResolverService } from '../configuracion/ai-provider-resolver.service';
import { ProveedorIA } from '../common/enums/proveedor-ia.enum';
import { filtrarFilasNoTransaccionales } from './validacion-saldo';

describe('filtrarFilasNoTransaccionales', () => {
  it('excluye filas de "Saldo Inicial"/"Saldo Final"/"Saldo Anterior"', () => {
    const movimientos = [
      { concepto: 'Saldo Inicial' },
      { concepto: 'saldo final' },
      { concepto: 'Saldo Anterior al 01/07' },
      { concepto: 'Pago comercios first data master nro.liq. 00210181' },
    ];

    expect(filtrarFilasNoTransaccionales(movimientos)).toEqual([
      { concepto: 'Pago comercios first data master nro.liq. 00210181' },
    ]);
  });

  it('no excluye un movimiento real cuyo concepto mencione "saldo" en otra posición', () => {
    const movimientos = [{ concepto: 'Ajuste de saldo por diferencia de cambio' }];

    expect(filtrarFilasNoTransaccionales(movimientos)).toEqual(movimientos);
  });
});

describe('ExtractosIaProcessor', () => {
  let processor: ExtractosIaProcessor;
  const estudioId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();
  const extractoId = new Types.ObjectId().toString();
  const clienteId = new Types.ObjectId();
  const cuentaBancariaId = new Types.ObjectId();

  const extractoModelMock: any = { findById: jest.fn() };

  // Fake que implementa AiExtractionPort, montado como el adapter stub — el
  // resolver por default resuelve `null` (sin nada conectado en
  // Configuración → Integraciones), así que `ExtractosIaProcessor` cae acá.
  const fakePort: any = { extraerMovimientos: jest.fn() };
  const anthropicAdapterMock: any = { extraerMovimientos: jest.fn() };
  const openAiAdapterMock: any = { extraerMovimientos: jest.fn() };
  const aiProviderResolverServiceMock = { resolver: jest.fn() };
  const pdfTextExtractorMock = { extraer: jest.fn() };
  const realtimeGatewayMock = { emitToEstudio: jest.fn() };
  const planCuentasServiceMock = { findAll: jest.fn() };
  const reglasClasificacionServiceMock = { findAll: jest.fn(), crearSugeridaPorIa: jest.fn() };

  function buildExtractoInstance(overrides: Record<string, unknown> = {}): any {
    const instance: any = {
      _id: extractoId,
      clienteId,
      cuentaBancariaId,
      nombreArchivo: 'extracto.pdf',
      estado: EstadoExtracto.PROCESANDO,
      movimientos: [],
      saldoInicialDeclarado: undefined,
      saldoFinalDeclarado: undefined,
      mensajeError: undefined,
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    return instance;
  }

  function buildJob(
    overrides: Partial<ProcesarExtractoJobData> = {},
  ): Job<ProcesarExtractoJobData> {
    return {
      data: {
        extractoId,
        estudioId,
        userId,
        nombreArchivo: 'extracto.pdf',
        contenidoBase64: 'QQ==',
        ...overrides,
      },
    } as Job<ProcesarExtractoJobData>;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: cliente sin plan de cuentas ni reglas — así los tests que no
    // les prestan atención (transcripción/validación de saldo) no dependen
    // de esto y no se disparan intentos de crear reglas.
    planCuentasServiceMock.findAll.mockResolvedValue({ data: [], total: 0, page: 1, limit: 100 });
    reglasClasificacionServiceMock.findAll.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
    });
    // Default: nada conectado en Configuración → Integraciones — cae al stub.
    aiProviderResolverServiceMock.resolver.mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExtractosIaProcessor,
        { provide: AiExtractionStubAdapter, useValue: fakePort },
        { provide: AnthropicExtractionAdapter, useValue: anthropicAdapterMock },
        { provide: OpenAiExtractionAdapter, useValue: openAiAdapterMock },
        { provide: AiProviderResolverService, useValue: aiProviderResolverServiceMock },
        { provide: getModelToken(ExtractoBancario.name), useValue: extractoModelMock },
        { provide: PdfTextExtractorService, useValue: pdfTextExtractorMock },
        { provide: RealtimeGateway, useValue: realtimeGatewayMock },
        { provide: PlanCuentasService, useValue: planCuentasServiceMock },
        { provide: ReglasClasificacionService, useValue: reglasClasificacionServiceMock },
      ],
    }).compile();

    processor = moduleRef.get(ExtractosIaProcessor);
  });

  it('descarta el job sin fallar si el extracto ya no existe (ej. borrado mientras esperaba en cola)', async () => {
    extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

    await processor.process(buildJob());

    expect(fakePort.extraerMovimientos).not.toHaveBeenCalled();
    expect(realtimeGatewayMock.emitToEstudio).not.toHaveBeenCalled();
  });

  it('procesa y notifica "procesado" cuando no hay saldo para validar', async () => {
    const instance = buildExtractoInstance();
    extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
    pdfTextExtractorMock.extraer.mockResolvedValue({
      texto: 'texto del pdf',
      tieneCapaDeTexto: true,
    });
    fakePort.extraerMovimientos.mockResolvedValue({
      exitoso: true,
      movimientos: [
        { fecha: '2026-07-01', concepto: 'Transferencia recibida', monto: 1000, tipo: 'credito' },
      ],
      reglasSugeridas: [],
      mensaje: 'ok',
    });

    await processor.process(buildJob());

    expect(pdfTextExtractorMock.extraer).toHaveBeenCalledWith('QQ==');
    expect(fakePort.extraerMovimientos).toHaveBeenCalledTimes(1);
    expect(instance.estado).toBe(EstadoExtracto.PROCESADO);
    expect(instance.movimientos).toHaveLength(1);
    expect(instance.movimientos[0].validacionSaldo).toBe(ValidacionSaldo.NO_APLICA);
    expect(instance.save).toHaveBeenCalledTimes(1);
    expect(realtimeGatewayMock.emitToEstudio).toHaveBeenCalledWith(
      estudioId,
      'extracto:procesado',
      {
        extractoId,
        estado: EstadoExtracto.PROCESADO,
        nombreArchivo: 'extracto.pdf',
      },
    );
  });

  it('no llama a la IA y notifica "error" si el PDF no tiene capa de texto', async () => {
    const instance = buildExtractoInstance();
    extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
    pdfTextExtractorMock.extraer.mockResolvedValue({ texto: '', tieneCapaDeTexto: false });

    await processor.process(buildJob());

    expect(fakePort.extraerMovimientos).not.toHaveBeenCalled();
    expect(instance.estado).toBe(EstadoExtracto.ERROR);
    expect(instance.mensajeError).toMatch(/sin capa de texto/i);
    expect(realtimeGatewayMock.emitToEstudio).toHaveBeenCalledWith(
      estudioId,
      'extracto:procesado',
      {
        extractoId,
        estado: EstadoExtracto.ERROR,
        nombreArchivo: 'extracto.pdf',
      },
    );
  });

  it('queda en estado "error" cuando el puerto responde no exitoso', async () => {
    const instance = buildExtractoInstance();
    extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
    pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
    fakePort.extraerMovimientos.mockResolvedValue({
      exitoso: false,
      movimientos: [],
      reglasSugeridas: [],
      mensaje: 'No se pudo estructurar el extracto',
    });

    await processor.process(buildJob());

    expect(instance.estado).toBe(EstadoExtracto.ERROR);
    expect(instance.mensajeError).toBe('No se pudo estructurar el extracto');
  });

  it('queda en estado "error" si el puerto lanza una excepción', async () => {
    const instance = buildExtractoInstance();
    extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
    pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
    fakePort.extraerMovimientos.mockRejectedValue(new Error('timeout del proveedor de IA'));

    await processor.process(buildJob());

    expect(instance.estado).toBe(EstadoExtracto.ERROR);
    expect(instance.mensajeError).toBe('timeout del proveedor de IA');
  });

  it('nunca queda "colgado": si el proveedor de IA no responde nunca, el timeout propio del pipeline fuerza a error', async () => {
    jest.useFakeTimers();
    try {
      const instance = buildExtractoInstance();
      extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
      // Simula un proveedor que nunca resuelve (red colgada, proxy que no corta la conexión, etc.)
      fakePort.extraerMovimientos.mockReturnValue(new Promise<never>(() => {}));

      const procesamiento = processor.process(buildJob());
      await jest.advanceTimersByTimeAsync(8 * 60 * 1000);
      await procesamiento;

      expect(instance.estado).toBe(EstadoExtracto.ERROR);
      expect(instance.mensajeError).toMatch(/tiempo máximo de procesamiento/i);
      expect(instance.save).toHaveBeenCalledTimes(1);
      expect(realtimeGatewayMock.emitToEstudio).toHaveBeenCalledWith(
        estudioId,
        'extracto:procesado',
        {
          extractoId,
          estado: EstadoExtracto.ERROR,
          nombreArchivo: 'extracto.pdf',
        },
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('emite eventos de progreso intermedios ("extracto:progreso") además del resultado final', async () => {
    const instance = buildExtractoInstance();
    extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
    pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
    fakePort.extraerMovimientos.mockResolvedValue({
      exitoso: true,
      movimientos: [],
      reglasSugeridas: [],
    });

    await processor.process(buildJob());

    const eventosProgreso = realtimeGatewayMock.emitToEstudio.mock.calls.filter(
      ([, evento]) => evento === 'extracto:progreso',
    );
    const porcentajes = eventosProgreso.map(
      ([, , payload]) => (payload as { porcentaje: number }).porcentaje,
    );

    expect(porcentajes).toEqual([10, 30, 70]);
    eventosProgreso.forEach(([estudio, , payload]) => {
      const progreso = payload as { extractoId: string; etapa: string };
      expect(estudio).toBe(estudioId);
      expect(progreso.extractoId).toBe(extractoId);
      expect(typeof progreso.etapa).toBe('string');
    });
  });

  describe('validación de saldo — datos reales del extracto Santander de Interprints (julio 2024)', () => {
    it('marca "ok" cuando el saldo declarado por fila coincide con el calculado', async () => {
      const instance = buildExtractoInstance();
      extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
      fakePort.extraerMovimientos.mockResolvedValue({
        exitoso: true,
        saldoInicialDeclarado: 47670.26,
        saldoFinalDeclarado: 507547.36,
        reglasSugeridas: [],
        movimientos: [
          {
            fecha: '01/07/24',
            concepto: 'Pago comercios frst data master nro.liq. 00210181/0015956286',
            monto: 79479.41,
            tipo: 'credito',
            saldoDespues: 127149.67,
          },
          {
            fecha: '01/07/24',
            concepto: 'Pago comercios frst data visa nro.liq. 00209717/0015956286',
            monto: 430697.69,
            tipo: 'credito',
            saldoDespues: 557847.36,
          },
          {
            fecha: '01/07/24',
            concepto: 'Pago de haberes 00720055007000356523ars',
            monto: 50000.0,
            tipo: 'debito',
            saldoDespues: 507847.36,
          },
          {
            fecha: '01/07/24',
            concepto: 'Impuesto ley 25.413 debito 0,6%',
            monto: 300.0,
            tipo: 'debito',
            saldoDespues: 507547.36,
          },
        ],
      });

      await processor.process(buildJob());

      expect(instance.movimientos.every((m: any) => m.validacionSaldo === ValidacionSaldo.OK)).toBe(
        true,
      );
      expect(instance.estado).toBe(EstadoExtracto.PROCESADO);
    });

    it('corrige sola un "tipo" invertido (crédito leído como débito) cuando el saldo declarado de la fila lo prueba matemáticamente — bug real reportado por el usuario', async () => {
      const instance = buildExtractoInstance();
      extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
      fakePort.extraerMovimientos.mockResolvedValue({
        exitoso: true,
        // Saldo ya en -34.720,01 antes de esta fila (mismo extracto real del reporte).
        saldoInicialDeclarado: -34720.01,
        saldoFinalDeclarado: -20127.21,
        reglasSugeridas: [],
        movimientos: [
          {
            fecha: '04/07/24',
            concepto:
              'Servicios de pago 30574816870 op9905299954 240702078americanexpress argentina 2',
            monto: 14592.8,
            // La IA lo transcribió como "debito" — el extracto real dice que es un crédito
            // (el saldo declarado por el propio banco para esta fila, -20.127,21, solo cierra
            // si el movimiento suma en vez de restar).
            tipo: 'debito',
            saldoDespues: -20127.21,
          },
        ],
      });

      await processor.process(buildJob());

      expect(instance.movimientos[0].tipo).toBe(TipoMovimiento.CREDITO);
      expect(instance.movimientos[0].saldoCalculado).toBe(-20127.21);
      expect(instance.movimientos[0].validacionSaldo).toBe(ValidacionSaldo.OK);
      expect(instance.estado).toBe(EstadoExtracto.PROCESADO);
    });

    it('NO corrige un "tipo" cuando la diferencia no coincide con el patrón de inversión (es un error de monto real, no de columna)', async () => {
      const instance = buildExtractoInstance();
      extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
      fakePort.extraerMovimientos.mockResolvedValue({
        exitoso: true,
        saldoInicialDeclarado: 1000,
        saldoFinalDeclarado: 1200,
        reglasSugeridas: [],
        movimientos: [
          {
            fecha: '01/01/26',
            concepto: 'Transferencia',
            monto: 100,
            tipo: 'credito',
            saldoDespues: 1200,
          },
        ],
      });

      await processor.process(buildJob());

      // 100 (monto) tipo "credito" con saldo inicial 1000 da 1100, no 1200 — pero el 2x
      // del monto (200) tampoco explica la diferencia real (100), así que no es una
      // inversión de columna: se deja como diferencia real para revisión manual.
      expect(instance.movimientos[0].tipo).toBe(TipoMovimiento.CREDITO);
      expect(instance.movimientos[0].validacionSaldo).toBe(ValidacionSaldo.DIFERENCIA);
    });

    it('descarta la fila "Saldo Inicial" colada por la IA como movimiento en vez de duplicar el saldo calculado', async () => {
      const instance = buildExtractoInstance();
      extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
      fakePort.extraerMovimientos.mockResolvedValue({
        exitoso: true,
        saldoInicialDeclarado: 47670.26,
        saldoFinalDeclarado: 127149.67,
        reglasSugeridas: [],
        movimientos: [
          {
            fecha: '29/06/24',
            concepto: 'Saldo Inicial',
            monto: 47670.26,
            tipo: null,
            saldoDespues: 47670.26,
          },
          {
            fecha: '01/07/24',
            concepto: 'Pago comercios frst data master nro.liq. 00210181/0015956286',
            monto: 79479.41,
            tipo: 'credito',
            saldoDespues: 127149.67,
          },
        ],
      });

      await processor.process(buildJob());

      expect(instance.movimientos).toHaveLength(1);
      expect(instance.movimientos[0].concepto).toContain('Pago comercios');
      expect(instance.movimientos[0].saldoCalculado).toBe(127149.67);
      expect(instance.movimientos[0].validacionSaldo).toBe(ValidacionSaldo.OK);
      expect(instance.estado).toBe(EstadoExtracto.PROCESADO);
    });

    it('detecta una diferencia real y reintenta antes de resignarse a REQUIERE_REVISION', async () => {
      const instance = buildExtractoInstance();
      extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });

      const primerIntento = {
        exitoso: true,
        saldoInicialDeclarado: 1000,
        saldoFinalDeclarado: 1200,
        reglasSugeridas: [],
        movimientos: [
          {
            fecha: '01/01/26',
            concepto: 'Transferencia',
            monto: 100,
            tipo: 'credito',
            saldoDespues: 1200,
          },
        ],
      };

      fakePort.extraerMovimientos.mockResolvedValueOnce(primerIntento);
      fakePort.extraerMovimientos.mockResolvedValueOnce(primerIntento);

      await processor.process(buildJob());

      expect(fakePort.extraerMovimientos).toHaveBeenCalledTimes(2);
      const [primeraLlamada, segundaLlamada] = fakePort.extraerMovimientos.mock.calls;
      expect(segundaLlamada[0].pistaRevision).toContain('100');
      // El reintento no vuelve a pedir contexto de clasificación — solo el primer intento lo tiene.
      expect(primeraLlamada[0].cuentasContablesDisponibles).toBeDefined();
      expect(segundaLlamada[0].cuentasContablesDisponibles).toBeUndefined();
      expect(instance.estado).toBe(EstadoExtracto.REQUIERE_REVISION);
      expect(instance.movimientos[0].validacionSaldo).toBe(ValidacionSaldo.DIFERENCIA);
    });

    it('si el reintento corrige el monto, el extracto queda "procesado" con los datos corregidos', async () => {
      const instance = buildExtractoInstance();
      extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });

      fakePort.extraerMovimientos.mockResolvedValueOnce({
        exitoso: true,
        saldoInicialDeclarado: 1000,
        saldoFinalDeclarado: 1200,
        reglasSugeridas: [],
        movimientos: [
          {
            fecha: '01/01/26',
            concepto: 'Transferencia',
            monto: 100,
            tipo: 'credito',
            saldoDespues: 1200,
          },
        ],
      });
      fakePort.extraerMovimientos.mockResolvedValueOnce({
        exitoso: true,
        saldoInicialDeclarado: 1000,
        saldoFinalDeclarado: 1200,
        reglasSugeridas: [],
        movimientos: [
          {
            fecha: '01/01/26',
            concepto: 'Transferencia',
            monto: 200,
            tipo: 'credito',
            saldoDespues: 1200,
          },
        ],
      });

      await processor.process(buildJob());

      expect(instance.estado).toBe(EstadoExtracto.PROCESADO);
      expect(instance.movimientos[0].monto).toBe(200);
      expect(instance.movimientos[0].validacionSaldo).toBe(ValidacionSaldo.OK);
    });
  });

  describe('inferencia de reglas de clasificación', () => {
    const cuentaContableId = new Types.ObjectId().toString();

    function mockCuentasYReglas() {
      planCuentasServiceMock.findAll.mockResolvedValue({
        data: [
          {
            _id: cuentaContableId,
            codigo: '519',
            nombre: 'Gastos Bancarios',
            naturaleza: 'deudora',
            activo: true,
          },
        ],
        total: 1,
        page: 1,
        limit: 100,
      });
    }

    function mockExtraccionExitosaCon(reglasSugeridas: unknown[]) {
      fakePort.extraerMovimientos.mockResolvedValue({
        exitoso: true,
        movimientos: [
          { fecha: '2026-08-10', concepto: 'Comisión mantenimiento', monto: -1200, tipo: 'debito' },
        ],
        reglasSugeridas,
      });
    }

    it('crea una regla por cada sugerencia cuyo código matchea una cuenta real', async () => {
      const instance = buildExtractoInstance();
      extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
      mockCuentasYReglas();
      mockExtraccionExitosaCon([
        {
          patronTexto: 'Comisión mantenimiento',
          cuentaCodigo: '519',
          ladoAsiento: 'debe',
          tipoMovimiento: 'debito',
        },
      ]);

      await processor.process(buildJob());

      expect(reglasClasificacionServiceMock.crearSugeridaPorIa).toHaveBeenCalledWith(
        expect.objectContaining({
          clienteId: clienteId.toString(),
          cuentaBancariaId: cuentaBancariaId.toString(),
          cuentaContableId,
          ladoAsiento: 'debe',
          patronTexto: 'Comisión mantenimiento',
          tipoMovimiento: 'debito',
        }),
        expect.any(Types.ObjectId),
        expect.any(Types.ObjectId),
      );
    });

    it('descarta (con log, sin fallar el job) una sugerencia con código de cuenta inexistente', async () => {
      const instance = buildExtractoInstance();
      extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
      mockCuentasYReglas();
      mockExtraccionExitosaCon([
        {
          patronTexto: 'Concepto raro',
          cuentaCodigo: '999-NO-EXISTE',
          ladoAsiento: 'debe',
          tipoMovimiento: null,
        },
      ]);

      await processor.process(buildJob());

      expect(reglasClasificacionServiceMock.crearSugeridaPorIa).not.toHaveBeenCalled();
      expect(instance.estado).toBe(EstadoExtracto.PROCESADO);
    });

    it('un error al crear una regla sugerida no rompe el guardado del extracto', async () => {
      const instance = buildExtractoInstance();
      extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
      mockCuentasYReglas();
      mockExtraccionExitosaCon([
        {
          patronTexto: 'Comisión mantenimiento',
          cuentaCodigo: '519',
          ladoAsiento: 'debe',
          tipoMovimiento: 'debito',
        },
      ]);
      reglasClasificacionServiceMock.crearSugeridaPorIa.mockRejectedValue(new Error('boom'));

      await processor.process(buildJob());

      expect(instance.estado).toBe(EstadoExtracto.PROCESADO);
      expect(realtimeGatewayMock.emitToEstudio).toHaveBeenCalled();
    });

    it('no intenta crear nada si la IA no sugiere reglas', async () => {
      const instance = buildExtractoInstance();
      extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
      mockCuentasYReglas();
      mockExtraccionExitosaCon([]);

      await processor.process(buildJob());

      expect(reglasClasificacionServiceMock.crearSugeridaPorIa).not.toHaveBeenCalled();
    });
  });

  describe('selección de proveedor de IA (Configuración → Integraciones)', () => {
    it('usa el adapter de Anthropic con la credencial resuelta cuando el resolver la indica', async () => {
      const instance = buildExtractoInstance();
      extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
      aiProviderResolverServiceMock.resolver.mockResolvedValue({
        proveedor: ProveedorIA.ANTHROPIC,
        apiKey: 'sk-ant-resuelta',
        modelo: 'claude-sonnet-5',
      });
      anthropicAdapterMock.extraerMovimientos.mockResolvedValue({
        exitoso: true,
        movimientos: [],
        reglasSugeridas: [],
      });

      await processor.process(buildJob());

      expect(aiProviderResolverServiceMock.resolver).toHaveBeenCalledWith(
        expect.any(Types.ObjectId),
        clienteId,
      );
      expect(anthropicAdapterMock.extraerMovimientos).toHaveBeenCalledWith(expect.any(Object), {
        apiKey: 'sk-ant-resuelta',
        modelo: 'claude-sonnet-5',
      });
      expect(openAiAdapterMock.extraerMovimientos).not.toHaveBeenCalled();
      expect(fakePort.extraerMovimientos).not.toHaveBeenCalled();
    });

    it('usa el adapter de OpenAI sin credencial explícita cuando el proveedor resuelto no tiene key propia conectada (cae al env del adapter)', async () => {
      const instance = buildExtractoInstance();
      extractoModelMock.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: 'texto', tieneCapaDeTexto: true });
      aiProviderResolverServiceMock.resolver.mockResolvedValue({ proveedor: ProveedorIA.OPENAI });
      openAiAdapterMock.extraerMovimientos.mockResolvedValue({
        exitoso: true,
        movimientos: [],
        reglasSugeridas: [],
      });

      await processor.process(buildJob());

      expect(openAiAdapterMock.extraerMovimientos).toHaveBeenCalledWith(
        expect.any(Object),
        undefined,
      );
      expect(anthropicAdapterMock.extraerMovimientos).not.toHaveBeenCalled();
      expect(fakePort.extraerMovimientos).not.toHaveBeenCalled();
    });
  });
});
