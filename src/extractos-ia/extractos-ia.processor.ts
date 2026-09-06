import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Job } from 'bullmq';
import {
  AiCredenciales,
  AiExtractionPort,
  MovimientoExtraido,
  ReglaClasificacionSugerida,
  ReglaExistenteResumen,
} from './ports/ai-extraction.port';
import { AiExtractionStubAdapter } from './adapters/ai-extraction-stub.adapter';
import { AnthropicExtractionAdapter } from './adapters/anthropic-extraction.adapter';
import { OpenAiExtractionAdapter } from './adapters/openai-extraction.adapter';
import { PdfTextExtractorService } from './pdf-text-extractor.service';
import {
  EstadoExtracto,
  ExtractoBancario,
  ExtractoBancarioDocument,
  TipoMovimiento,
  ValidacionSaldo,
} from './schemas/extracto-bancario.schema';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PlanCuentasService } from '../plan-cuentas/plan-cuentas.service';
import { CuentaContableDocument } from '../plan-cuentas/schemas/cuenta-contable.schema';
import { ReglasClasificacionService } from '../reglas-clasificacion/reglas-clasificacion.service';
import { LadoAsiento } from '../reglas-clasificacion/schemas/regla-clasificacion.schema';
import { AiProviderResolverService } from '../configuracion/ai-provider-resolver.service';
import { ProveedorIA } from '../common/enums/proveedor-ia.enum';
import { conTimeout } from '../common/utils/con-timeout';
import {
  MovimientoValidable,
  construirMovimientosConValidacion,
  contarDiferencias,
  describirDiferencias,
  determinarEstadoFinal,
  filtrarFilasNoTransaccionales,
} from './validacion-saldo';

export interface ProcesarExtractoJobData {
  extractoId: string;
  estudioId: string;
  userId: string;
  nombreArchivo: string;
  contenidoBase64: string;
}

/**
 * Techo de tiempo para el pipeline completo (PDF + IA + validación de
 * saldo), sea cual sea la causa de la demora (proveedor de IA que no
 * responde, red colgada, lo que sea) — ver `conTimeout` y su uso en
 * `ExtractosIaProcessor.process`. Deliberadamente más laxo que el timeout
 * default de los SDKs de Anthropic/OpenAI (10 min) para que sea ESTE el que
 * gane la carrera y deje un mensaje de error legible en vez de que el SDK
 * tire su propio error crudo primero.
 */
const TIMEOUT_PROCESAMIENTO_MS = 8 * 60 * 1000;

/**
 * Worker BullMQ que hace el trabajo pesado que antes vivía en
 * `ExtractosIaService.cargarExtracto`: extraer el texto del PDF, llamar al
 * `AiExtractionPort` (con el reintento acotado si hay diferencias de saldo),
 * validar saldos y persistir el resultado final. Corre fuera de la request
 * HTTP que subió el archivo — `ExtractosIaService.cargarExtracto` ya
 * respondió hace rato con el documento en `PROCESANDO`.
 *
 * Además, en la misma llamada de IA (no una aparte — evita re-mandar el
 * texto del PDF y un segundo round-trip) le pide al proveedor que infiera
 * reglas de clasificación para patrones recurrentes que mapeen con confianza
 * a una cuenta YA EXISTENTE del plan de cuentas del cliente (nunca inventa
 * cuentas nuevas). Esas reglas quedan activas de inmediato (procedencia
 * `IA`, prioridad baja — nunca le ganan a una regla manual/aprendida para el
 * mismo movimiento), así el asiento contable del propio extracto recién
 * procesado ya las usa para agrupar. El reintento por diferencia de saldo NO
 * vuelve a pedir este contexto — las reglas sugeridas siempre salen del
 * primer intento exitoso.
 *
 * Al terminar (éxito, `requiere_revision` o error) notifica por WebSocket
 * vía `RealtimeGateway` a la room del estudio dueño del extracto, para que
 * el Frontend actualice la fila sin tener que pollear. Mientras el pipeline
 * corre, además emite `extracto:progreso` (etapa + porcentaje aproximado) en
 * cada punto intermedio — ver `notificarProgreso` — para que el Frontend
 * muestre avance real en vez de un spinner ciego.
 *
 * GARANTÍA CONTRA QUEDAR "COLGADO": todo el pipeline (`ejecutarPipeline`)
 * corre contra un timeout propio de `TIMEOUT_PROCESAMIENTO_MS` (ver
 * `conTimeout`) — si nada respondió en ese lapso (típicamente el proveedor
 * de IA), el job igual termina en ese momento con el extracto en `ERROR` en
 * vez de seguir "procesando" para siempre. Esto cubre el caso de que la
 * llamada externa nunca vuelva; NO cubre el caso de que el proceso de Node
 * entero se caiga a mitad de un job (sobre todo en `QUEUE_MODE=inline`, sin
 * persistencia de la cola) — para eso existe `ExtractosIaWatchdogService`
 * (cron cada 5 min, `extractos-ia-watchdog.service.ts`), que fuerza a error
 * cualquier extracto que siga en `PROCESANDO` mucho después de este timeout.
 *
 * Nota sobre la carrera contra el timeout: si `ejecutarPipeline` pierde la
 * carrera, su promesa sigue corriendo "abandonada" en el event loop (Node no
 * cancela un `await` en curso) — pero como `extracto.save()` y `notificar()`
 * ya corrieron con el resultado del timeout, y nada vuelve a leer lo que esa
 * promesa abandonada eventualmente resuelva, no hay riesgo de que un
 * resultado tardío pise el `ERROR` ya persistido.
 *
 * PROVEEDOR DE IA: ya no se inyecta un único `AiExtractionPort` fijo por
 * variable de entorno (`AI_PROVIDER`) — se inyectan los tres adapters
 * directo y, al ppio de cada job, `AiProviderResolverService` resuelve cuál
 * usar (y con qué credencial) para `(estudioId, extracto.clienteId)` — ver
 * Configuración → Integraciones. Sin ninguna integración conectada, resuelve
 * `null` y se cae al stub, igual que el comportamiento previo a ese módulo.
 */
@Processor('extractos-ia')
export class ExtractosIaProcessor extends WorkerHost {
  private readonly logger = new Logger(ExtractosIaProcessor.name);

  constructor(
    @InjectModel(ExtractoBancario.name)
    private readonly extractoModel: Model<ExtractoBancarioDocument>,
    private readonly pdfTextExtractor: PdfTextExtractorService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly planCuentasService: PlanCuentasService,
    private readonly reglasClasificacionService: ReglasClasificacionService,
    private readonly aiProviderResolverService: AiProviderResolverService,
    private readonly anthropicAdapter: AnthropicExtractionAdapter,
    private readonly openAiAdapter: OpenAiExtractionAdapter,
    private readonly stubAdapter: AiExtractionStubAdapter,
  ) {
    super();
  }

  /** Resuelve, para este job puntual, qué adapter usar y con qué credencial (ver Configuración → Integraciones). */
  private async resolverAdapter(
    estudioId: Types.ObjectId,
    clienteId: Types.ObjectId,
  ): Promise<{ port: AiExtractionPort; credenciales?: AiCredenciales }> {
    const credencial = await this.aiProviderResolverService.resolver(estudioId, clienteId);
    if (!credencial) {
      return { port: this.stubAdapter };
    }

    const port =
      credencial.proveedor === ProveedorIA.ANTHROPIC ? this.anthropicAdapter : this.openAiAdapter;
    return {
      port,
      credenciales: credencial.apiKey
        ? { apiKey: credencial.apiKey, modelo: credencial.modelo }
        : undefined,
    };
  }

  async process(job: Job<ProcesarExtractoJobData>): Promise<void> {
    const { extractoId, estudioId, userId, nombreArchivo, contenidoBase64 } = job.data;

    const extracto = await this.extractoModel.findById(extractoId).exec();
    if (!extracto) {
      this.logger.warn(`Job descartado: el extracto ${extractoId} ya no existe.`);
      return;
    }

    let reglasSugeridas: ReglaClasificacionSugerida[] = [];
    let cuentasContables: CuentaContableDocument[] = [];

    try {
      const resultadoPipeline = await conTimeout(
        this.ejecutarPipeline(extracto, estudioId, nombreArchivo, contenidoBase64),
        TIMEOUT_PROCESAMIENTO_MS,
        `Se superó el tiempo máximo de procesamiento (${TIMEOUT_PROCESAMIENTO_MS / 60000} minutos) sin respuesta del proveedor de IA.`,
      );
      reglasSugeridas = resultadoPipeline.reglasSugeridas;
      cuentasContables = resultadoPipeline.cuentasContables;
    } catch (error) {
      const mensaje =
        error instanceof Error ? error.message : 'Error desconocido al procesar el extracto';
      this.logger.error(`Falló la extracción IA para "${nombreArchivo}": ${mensaje}`);
      extracto.estado = EstadoExtracto.ERROR;
      extracto.mensajeError = mensaje;
    }

    await extracto.save();
    await this.crearReglasSugeridas(reglasSugeridas, cuentasContables, extracto, estudioId, userId);
    this.notificar(estudioId, extracto);
  }

  /**
   * El trabajo pesado propiamente dicho, separado de `process` para poder
   * correrlo contra `conTimeout` sin duplicar el guardado/notificación final
   * en cada punto de salida — antes cada rama de error temprano (PDF sin
   * texto, IA no exitosa) hacía su propio `save`+`notificar`+`return`; ahora
   * todas las ramas solo dejan a `extracto` en el estado que corresponda y
   * `process` se encarga una única vez de persistir y notificar.
   */
  private async ejecutarPipeline(
    extracto: ExtractoBancarioDocument,
    estudioId: string,
    nombreArchivo: string,
    contenidoBase64: string,
  ): Promise<{
    reglasSugeridas: ReglaClasificacionSugerida[];
    cuentasContables: CuentaContableDocument[];
  }> {
    const extractoId = extracto._id.toString();

    this.notificarProgreso(estudioId, extractoId, 'Leyendo el PDF', 10);
    const { texto, tieneCapaDeTexto } = await this.pdfTextExtractor.extraer(contenidoBase64);

    if (!tieneCapaDeTexto) {
      extracto.estado = EstadoExtracto.ERROR;
      extracto.mensajeError =
        'PDF sin capa de texto, probablemente escaneado. No se envió a la IA.';
      return { reglasSugeridas: [], cuentasContables: [] };
    }

    const estudioObjectId = new Types.ObjectId(estudioId);
    const { port: aiExtractionPort, credenciales } = await this.resolverAdapter(
      estudioObjectId,
      extracto.clienteId,
    );
    const cuentasContables = await this.obtenerCuentasContablesActivas(estudioObjectId);
    const reglasExistentes = await this.obtenerReglasExistentes(
      extracto.clienteId,
      extracto.cuentaBancariaId,
      estudioObjectId,
      cuentasContables,
    );

    this.notificarProgreso(
      estudioId,
      extractoId,
      'Consultando la IA para transcribir los movimientos',
      30,
    );
    let resultado = await aiExtractionPort.extraerMovimientos(
      {
        nombreArchivo,
        texto,
        cuentasContablesDisponibles: cuentasContables.map((c) => ({
          codigo: c.codigo,
          nombre: c.nombre,
          naturaleza: c.naturaleza,
        })),
        reglasExistentes,
      },
      credenciales,
    );

    if (!resultado.exitoso) {
      extracto.estado = EstadoExtracto.ERROR;
      extracto.mensajeError = resultado.mensaje ?? 'No se pudo procesar el extracto.';
      return { reglasSugeridas: [], cuentasContables };
    }

    // Se captura del primer intento — el reintento (abajo) es solo para
    // corregir filas con diferencia de saldo, no vuelve a pedir contexto
    // de plan de cuentas/reglas ni a inferir reglas de nuevo.
    const reglasSugeridas = resultado.reglasSugeridas ?? [];

    this.notificarProgreso(estudioId, extractoId, 'Validando saldos', 70);
    let movimientos = construirMovimientosConValidacion(
      this.mapearExtraidos(filtrarFilasNoTransaccionales(resultado.movimientos)),
      resultado.saldoInicialDeclarado,
    );

    // Reintento acotado (máx. 1): si hay diferencias de saldo, se le pide a
    // la IA que revise solo las filas problemáticas antes de resignarse.
    if (movimientos.some((m) => m.validacionSaldo === ValidacionSaldo.DIFERENCIA)) {
      this.notificarProgreso(estudioId, extractoId, 'Revisando diferencias de saldo con la IA', 85);
      const reintento = await aiExtractionPort.extraerMovimientos(
        {
          nombreArchivo,
          texto,
          pistaRevision: describirDiferencias(movimientos),
        },
        credenciales,
      );

      if (reintento.exitoso) {
        const movimientosReintento = construirMovimientosConValidacion(
          this.mapearExtraidos(filtrarFilasNoTransaccionales(reintento.movimientos)),
          reintento.saldoInicialDeclarado,
        );
        if (contarDiferencias(movimientosReintento) < contarDiferencias(movimientos)) {
          movimientos = movimientosReintento;
          resultado = reintento;
        }
      }
    }

    extracto.movimientos = movimientos;
    extracto.saldoInicialDeclarado = resultado.saldoInicialDeclarado;
    extracto.saldoFinalDeclarado = resultado.saldoFinalDeclarado;
    extracto.estado = determinarEstadoFinal(movimientos, resultado.saldoFinalDeclarado);
    extracto.mensajeError = undefined;

    return { reglasSugeridas, cuentasContables };
  }

  /** Avance intermedio (no el resultado final, ver `notificar`) — `porcentaje` es aproximado, no viene de trabajo medible real. */
  private notificarProgreso(
    estudioId: string,
    extractoId: string,
    etapa: string,
    porcentaje: number,
  ): void {
    this.realtimeGateway.emitToEstudio(estudioId, 'extracto:progreso', {
      extractoId,
      etapa,
      porcentaje,
    });
  }

  /** Plan de cuentas del estudio — compartido entre clientes (ver `CuentaContable`), ya no filtrado por `clienteId`. */
  private async obtenerCuentasContablesActivas(
    estudioId: Types.ObjectId,
  ): Promise<CuentaContableDocument[]> {
    const cuentas = await this.planCuentasService.findAll({ limit: 100 }, estudioId);
    return cuentas.data.filter((c) => c.activo);
  }

  /** Reglas ya activas del cliente que aplican a esta cuenta bancaria (propias o sin scope), en el formato liviano que espera el puerto de IA. */
  private async obtenerReglasExistentes(
    clienteId: Types.ObjectId,
    cuentaBancariaId: Types.ObjectId,
    estudioId: Types.ObjectId,
    cuentasContables: CuentaContableDocument[],
  ): Promise<ReglaExistenteResumen[]> {
    const reglas = await this.reglasClasificacionService.findAll(
      { clienteId: clienteId.toString(), activa: true, limit: 100 },
      estudioId,
    );
    const cuentaCodigoPorId = new Map(cuentasContables.map((c) => [c._id.toString(), c.codigo]));

    return reglas.data
      .filter(
        (r) => !r.cuentaBancariaId || r.cuentaBancariaId.toString() === cuentaBancariaId.toString(),
      )
      .map((r) => ({
        patronTexto: r.patronTexto,
        cuentaCodigo: cuentaCodigoPorId.get(r.cuentaContableId.toString()) ?? '',
      }))
      .filter((r) => r.cuentaCodigo);
  }

  /** Crea una `ReglaClasificacion` por cada sugerencia cuyo código de cuenta matchea una cuenta real. Nunca rompe el job por una sugerencia inválida. */
  private async crearReglasSugeridas(
    sugerencias: ReglaClasificacionSugerida[],
    cuentasContables: CuentaContableDocument[],
    extracto: ExtractoBancarioDocument,
    estudioId: string,
    userId: string,
  ): Promise<void> {
    if (sugerencias.length === 0) return;

    const cuentaIdPorCodigo = new Map(cuentasContables.map((c) => [c.codigo, c._id.toString()]));

    for (const sugerencia of sugerencias) {
      const cuentaContableId = cuentaIdPorCodigo.get(sugerencia.cuentaCodigo);
      if (!cuentaContableId) {
        this.logger.warn(
          `Regla sugerida ignorada: código de cuenta "${sugerencia.cuentaCodigo}" no existe para el cliente ${extracto.clienteId.toString()}.`,
        );
        continue;
      }

      try {
        await this.reglasClasificacionService.crearSugeridaPorIa(
          {
            clienteId: extracto.clienteId.toString(),
            cuentaBancariaId: extracto.cuentaBancariaId.toString(),
            conceptoContable: sugerencia.patronTexto,
            cuentaContableId,
            ladoAsiento: sugerencia.ladoAsiento as LadoAsiento,
            patronTexto: sugerencia.patronTexto,
            tipoMovimiento: sugerencia.tipoMovimiento,
          },
          new Types.ObjectId(estudioId),
          new Types.ObjectId(userId),
        );
      } catch (error) {
        const mensaje = error instanceof Error ? error.message : 'Error desconocido';
        this.logger.warn(
          `No se pudo crear la regla sugerida por IA ("${sugerencia.patronTexto}"): ${mensaje}`,
        );
      }
    }
  }

  private notificar(estudioId: string, extracto: ExtractoBancarioDocument): void {
    this.realtimeGateway.emitToEstudio(estudioId, 'extracto:procesado', {
      extractoId: extracto._id.toString(),
      estado: extracto.estado,
      nombreArchivo: extracto.nombreArchivo,
    });
  }

  private mapearExtraidos(movimientos: MovimientoExtraido[]): MovimientoValidable[] {
    return movimientos.map((m) => ({
      fecha: m.fecha,
      concepto: m.concepto,
      monto: m.monto,
      tipo: m.tipo as TipoMovimiento | undefined,
      numeroComprobante: m.numeroComprobante,
      saldoDeclarado: m.saldoDespues,
    }));
  }
}
