import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { EXTRACTOS_PROCESSING_QUEUE, ExtractosIaService } from './extractos-ia.service';
import {
  EstadoExtracto,
  ExtractoBancario,
  ValidacionSaldo,
} from './schemas/extracto-bancario.schema';
import { PdfTextExtractorService } from './pdf-text-extractor.service';
import { CuentasBancariasService } from '../cuentas-bancarias/cuentas-bancarias.service';
import { ExtractoDeteccionService } from './extracto-deteccion.service';

describe('ExtractosIaService', () => {
  let service: ExtractosIaService;
  const estudioId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const clienteId = new Types.ObjectId().toString();
  const cuentaBancariaId = new Types.ObjectId().toString();

  const extractoModelMock: any = {
    create: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    countDocuments: jest.fn(),
  };

  const pdfTextExtractorMock = { extraer: jest.fn() };
  const cuentasBancariasServiceMock = { findOne: jest.fn() };
  // Reemplaza la cola real (BullMQ/Redis) — `cargarExtracto` solo debe
  // encolar un job, nunca procesar nada él mismo (eso lo hace
  // `ExtractosIaProcessor`, ver `extractos-ia.processor.spec.ts`).
  const queueMock = { add: jest.fn() };

  function buildExtractoInstance(overrides: Record<string, unknown> = {}): any {
    const instance: any = {
      nombreArchivo: 'extracto.pdf',
      cuentaBancariaId: new Types.ObjectId(cuentaBancariaId),
      periodo: '2026-07',
      estado: EstadoExtracto.PROCESANDO,
      movimientos: [],
      saldoInicialDeclarado: undefined,
      saldoFinalDeclarado: undefined,
      mensajeError: undefined,
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    instance.toObject = jest.fn(() => ({
      nombreArchivo: instance.nombreArchivo,
      estado: instance.estado,
      movimientos: instance.movimientos,
      saldoInicialDeclarado: instance.saldoInicialDeclarado,
      saldoFinalDeclarado: instance.saldoFinalDeclarado,
      mensajeError: instance.mensajeError,
    }));
    return instance;
  }

  const createDto = {
    nombreArchivo: 'extracto.pdf',
    contenidoBase64: 'QQ==',
    clienteId,
    cuentaBancariaId,
    periodo: '2026-07',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    cuentasBancariasServiceMock.findOne.mockResolvedValue({
      clienteId: { toString: () => clienteId },
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        ExtractosIaService,
        { provide: getModelToken(ExtractoBancario.name), useValue: extractoModelMock },
        { provide: PdfTextExtractorService, useValue: pdfTextExtractorMock },
        { provide: CuentasBancariasService, useValue: cuentasBancariasServiceMock },
        { provide: EXTRACTOS_PROCESSING_QUEUE, useValue: queueMock },
        ExtractoDeteccionService,
      ],
    }).compile();

    service = moduleRef.get(ExtractosIaService);
  });

  describe('cargarExtracto', () => {
    it('rechaza si la cuenta bancaria pertenece a otro cliente', async () => {
      cuentasBancariasServiceMock.findOne.mockResolvedValue({
        clienteId: { toString: () => new Types.ObjectId().toString() },
      });

      await expect(service.cargarExtracto(createDto, estudioId, userId)).rejects.toThrow(
        BadRequestException,
      );
      expect(extractoModelMock.create).not.toHaveBeenCalled();
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('crea el documento en PROCESANDO y encola el job, sin procesar nada de forma síncrona', async () => {
      const nuevoId = new Types.ObjectId().toString();
      const instance = buildExtractoInstance({ _id: nuevoId });
      extractoModelMock.create.mockResolvedValue(instance);

      const result = await service.cargarExtracto(createDto, estudioId, userId);

      expect(extractoModelMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          clienteId: expect.any(Types.ObjectId),
          cuentaBancariaId: expect.any(Types.ObjectId),
          periodo: '2026-07',
          estado: EstadoExtracto.PROCESANDO,
          estudioId,
        }),
      );
      expect(queueMock.add).toHaveBeenCalledWith('procesar', {
        extractoId: nuevoId,
        estudioId: estudioId.toString(),
        userId: userId.toString(),
        nombreArchivo: 'extracto.pdf',
        contenidoBase64: 'QQ==',
      });
      expect(pdfTextExtractorMock.extraer).not.toHaveBeenCalled();
      expect(result.estado).toBe(EstadoExtracto.PROCESANDO);
      expect(instance.save).not.toHaveBeenCalled();
    });

    it('si la cola no responde a tiempo (ej. Redis caído/colgado), el extracto pasa a error y la request falla rápido en vez de quedar colgada', async () => {
      jest.useFakeTimers();
      try {
        const nuevoId = new Types.ObjectId().toString();
        const instance = buildExtractoInstance({ _id: nuevoId });
        extractoModelMock.create.mockResolvedValue(instance);
        // Simula una cola que nunca confirma el encolado (conexión "abierta" pero sin responder).
        queueMock.add.mockReturnValue(new Promise<never>(() => {}));

        const promesa = service.cargarExtracto(createDto, estudioId, userId);
        const expectativa = expect(promesa).rejects.toThrow(ServiceUnavailableException);
        await jest.advanceTimersByTimeAsync(8000);
        await expectativa;

        expect(instance.estado).toBe(EstadoExtracto.ERROR);
        expect(instance.mensajeError).toMatch(/no respondió a tiempo/i);
        expect(instance.save).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('findAll devuelve el listado paginado filtrado por estudio', async () => {
    const execMock = jest.fn().mockResolvedValue([{ nombreArchivo: 'a.pdf' }]);
    extractoModelMock.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      exec: execMock,
    });
    extractoModelMock.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(1) });

    const result = await service.findAll({ page: 1, limit: 10, sortDir: 'asc' }, estudioId);

    expect(extractoModelMock.find).toHaveBeenCalledWith(expect.objectContaining({ estudioId }));
    expect(result).toEqual({ data: [{ nombreArchivo: 'a.pdf' }], total: 1, page: 1, limit: 10 });
  });

  it('findOne lanza NotFoundException si no existe en el estudio', async () => {
    extractoModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

    await expect(service.findOne('507f1f77bcf86cd799439011', estudioId)).rejects.toThrow(
      NotFoundException,
    );
  });

  describe('actualizarMovimientos', () => {
    it('reemplaza los movimientos y recalcula subtotalesPorConcepto', async () => {
      const instance = buildExtractoInstance({
        estado: EstadoExtracto.PROCESADO,
        movimientos: [{ concepto: 'Viejo', monto: 1, fecha: '2026-01-01' }],
      });
      extractoModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });

      const nuevosMovimientos = [
        { fecha: '2026-08-01', concepto: 'Transferencia', monto: 1000 },
        { fecha: '2026-08-02', concepto: 'Transferencia', monto: 500 },
        { fecha: '2026-08-03', concepto: 'Comisión mantenimiento', monto: -200 },
      ];

      const result = await service.actualizarMovimientos(
        '507f1f77bcf86cd799439011',
        nuevosMovimientos,
        estudioId,
      );

      expect(instance.movimientos).toHaveLength(3);
      expect(instance.movimientos.map((m: { concepto: string }) => m.concepto)).toEqual([
        'Transferencia',
        'Transferencia',
        'Comisión mantenimiento',
      ]);
      expect(instance.save).toHaveBeenCalledTimes(1);
      expect(result.subtotalesPorConcepto).toEqual({
        Transferencia: 1500,
        'Comisión mantenimiento': -200,
      });
    });

    it('si la corrección manual resuelve la diferencia, el extracto vuelve a "procesado"', async () => {
      const instance = buildExtractoInstance({
        estado: EstadoExtracto.REQUIERE_REVISION,
        saldoInicialDeclarado: 1000,
        saldoFinalDeclarado: 1200,
        movimientos: [
          {
            fecha: '01/01/26',
            concepto: 'Transferencia',
            monto: 100,
            tipo: 'credito',
            saldoDeclarado: 1200,
            validacionSaldo: ValidacionSaldo.DIFERENCIA,
          },
        ],
      });
      extractoModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });

      const result = await service.actualizarMovimientos(
        '507f1f77bcf86cd799439011',
        [
          {
            fecha: '01/01/26',
            concepto: 'Transferencia',
            monto: 200,
            tipo: 'credito' as any,
            saldoDeclarado: 1200,
          },
        ],
        estudioId,
      );

      expect(instance.estado).toBe(EstadoExtracto.PROCESADO);
      expect((result as any).movimientos[0].validacionSaldo).toBe(ValidacionSaldo.OK);
    });

    it('permite corregir manualmente un "tipo" (débito↔crédito) mal leído por la IA y recalcula el saldo — escape hatch pedido por el usuario para lo que el auto-fix no cubra', async () => {
      const instance = buildExtractoInstance({
        estado: EstadoExtracto.REQUIERE_REVISION,
        saldoInicialDeclarado: 1000,
        movimientos: [
          {
            fecha: '01/01/26',
            concepto: 'Transferencia',
            monto: 300,
            tipo: 'debito',
            saldoDeclarado: 1300,
            validacionSaldo: ValidacionSaldo.DIFERENCIA,
          },
        ],
      });
      extractoModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });

      // El contador abre el pencil, cambia el "Tipo" de Débito a Crédito (el monto queda
      // igual, siempre positivo — el signo lo pone "tipo") y guarda.
      const result = await service.actualizarMovimientos(
        '507f1f77bcf86cd799439011',
        [
          {
            fecha: '01/01/26',
            concepto: 'Transferencia',
            monto: 300,
            tipo: 'credito' as any,
            saldoDeclarado: 1300,
          },
        ],
        estudioId,
      );

      expect((result as any).movimientos[0].tipo).toBe('credito');
      expect((result as any).movimientos[0].saldoCalculado).toBe(1300);
      expect((result as any).movimientos[0].validacionSaldo).toBe(ValidacionSaldo.OK);
      expect(instance.estado).toBe(EstadoExtracto.PROCESADO);
    });
  });

  describe('actualizarDatos', () => {
    it('rechaza si la nueva cuenta bancaria no pertenece al cliente indicado', async () => {
      const instance = buildExtractoInstance({
        clienteId: new Types.ObjectId(clienteId),
        cuentaBancariaId: new Types.ObjectId(cuentaBancariaId),
      });
      extractoModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });
      cuentasBancariasServiceMock.findOne.mockResolvedValue({
        clienteId: { toString: () => new Types.ObjectId().toString() },
      });

      const otraCuentaId = new Types.ObjectId().toString();
      await expect(
        service.actualizarDatos(
          '507f1f77bcf86cd799439011',
          { cuentaBancariaId: otraCuentaId },
          estudioId,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(instance.save).not.toHaveBeenCalled();
    });

    it('actualiza cliente y cuenta bancaria cuando la pertenencia es válida', async () => {
      const instance = buildExtractoInstance({
        clienteId: new Types.ObjectId(clienteId),
        cuentaBancariaId: new Types.ObjectId(cuentaBancariaId),
      });
      extractoModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });

      const nuevoClienteId = new Types.ObjectId().toString();
      const nuevaCuentaId = new Types.ObjectId().toString();
      cuentasBancariasServiceMock.findOne.mockResolvedValue({
        clienteId: { toString: () => nuevoClienteId },
      });

      await service.actualizarDatos(
        '507f1f77bcf86cd799439011',
        { clienteId: nuevoClienteId, cuentaBancariaId: nuevaCuentaId },
        estudioId,
      );

      expect(instance.clienteId.toString()).toBe(nuevoClienteId);
      expect(instance.cuentaBancariaId.toString()).toBe(nuevaCuentaId);
      expect(instance.save).toHaveBeenCalledTimes(1);
    });

    it('no toca nada ni guarda si el DTO viene vacío', async () => {
      const instance = buildExtractoInstance();
      extractoModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });

      await service.actualizarDatos('507f1f77bcf86cd799439011', {}, estudioId);

      expect(instance.save).not.toHaveBeenCalled();
      expect(cuentasBancariasServiceMock.findOne).not.toHaveBeenCalled();
    });
  });

  describe('eliminar', () => {
    it('elimina el documento del estudio correspondiente', async () => {
      const instance = buildExtractoInstance({ deleteOne: jest.fn().mockResolvedValue(undefined) });
      extractoModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(instance) });

      await service.eliminar('507f1f77bcf86cd799439011', estudioId);

      expect(instance.deleteOne).toHaveBeenCalledTimes(1);
    });

    it('lanza NotFoundException si el extracto no existe en el estudio', async () => {
      extractoModelMock.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      await expect(service.eliminar('507f1f77bcf86cd799439011', estudioId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('analizarEncabezado', () => {
    const analizarDto = { nombreArchivo: 'extracto.pdf', contenidoBase64: 'QQ==' };

    it('devuelve tieneCapaDeTexto=false sin llamar al detector si el PDF no tiene capa de texto', async () => {
      pdfTextExtractorMock.extraer.mockResolvedValue({ texto: '', tieneCapaDeTexto: false });

      const result = await service.analizarEncabezado(analizarDto);

      expect(result).toEqual({ tieneCapaDeTexto: false });
    });

    it('detecta CUIT y período del texto extraído', async () => {
      pdfTextExtractorMock.extraer.mockResolvedValue({
        texto: 'CUIT: 30-71234567-8\nPeríodo: 01/08/2026 al 31/08/2026',
        tieneCapaDeTexto: true,
      });

      const result = await service.analizarEncabezado(analizarDto);

      expect(result).toEqual({
        tieneCapaDeTexto: true,
        cuitDetectado: '30-71234567-8',
        periodoDetectado: '2026-08',
      });
    });

    it('no persiste nada ni requiere estudioId', async () => {
      pdfTextExtractorMock.extraer.mockResolvedValue({
        texto: 'Extracto sin CUIT ni período reconocibles.',
        tieneCapaDeTexto: true,
      });

      await service.analizarEncabezado(analizarDto);

      expect(extractoModelMock.create).not.toHaveBeenCalled();
    });
  });
});
