import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type ExtractoBancarioDocument = HydratedDocument<ExtractoBancario>;

export enum EstadoExtracto {
  PENDIENTE = 'pendiente',
  PROCESANDO = 'procesando',
  PROCESADO = 'procesado',
  /**
   * El extracto se estructuró correctamente, pero la validación
   * determinística de saldo (fila por fila y/o el saldo final) encontró al
   * menos una diferencia fuera de tolerancia. Nunca pasa a `PROCESADO`
   * silenciosamente — la integridad de los datos manda por sobre la
   * conveniencia (ver `ExtractosIaService.validarSaldos`).
   */
  REQUIERE_REVISION = 'requiere_revision',
  ERROR = 'error',
}

export enum TipoMovimiento {
  DEBITO = 'debito',
  CREDITO = 'credito',
}

export enum ValidacionSaldo {
  OK = 'ok',
  DIFERENCIA = 'diferencia',
  /** No hay saldo declarado para esa fila (banco sin saldo corrido, o extracto legado). */
  NO_APLICA = 'no_aplica',
}

/**
 * Movimiento individual extraído del PDF (o editado a mano por el contador —
 * checklist FOLGAR-009: "Tabla de resultados editables antes de confirmar").
 *
 * `fecha` se guarda como texto libre (no `Date`) a propósito: viene tal cual
 * la devuelve el proveedor de IA a partir de lo impreso en el extracto, y el
 * contador la puede editar en un campo de texto simple sin lidiar con parsing
 * de formatos regionales ni zonas horarias. Si en el futuro se necesita
 * ordenar/filtrar por fecha real, se puede sumar un campo `Date` derivado sin
 * romper este.
 */
@Schema({ _id: true })
export class MovimientoExtracto {
  /** Asignado automáticamente por Mongoose (`_id: true`) — declarado acá para que quede tipado, no lo setea nadie a mano. */
  _id?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  fecha: string;

  @Prop({ required: true, trim: true })
  concepto: string;

  @Prop({ required: true })
  monto: number;

  @Prop({ type: String, enum: TipoMovimiento })
  tipo?: TipoMovimiento;

  @Prop({ trim: true })
  numeroComprobante?: string;

  /** Saldo en cuenta declarado por el banco para esta fila (impreso en el extracto). */
  @Prop()
  saldoDeclarado?: number;

  /** Saldo calculado determinísticamente por el backend: saldoAnterior +/- este movimiento. */
  @Prop()
  saldoCalculado?: number;

  /** `saldoDeclarado - saldoCalculado`. Debería ser ~0; si no, hay un movimiento mal extraído o faltante. */
  @Prop()
  diferenciaSaldo?: number;

  @Prop({ type: String, enum: ValidacionSaldo, default: ValidacionSaldo.NO_APLICA })
  validacionSaldo: ValidacionSaldo;
}

export const MovimientoExtractoSchema = SchemaFactory.createForClass(MovimientoExtracto);

/**
 * Extracto bancario cargado por el contador y procesado (o no) por el puerto
 * de IA (`AiExtractionPort`). Módulo "Procesador de Extractos con IA"
 * (backlog FOLGAR-007 a FOLGAR-012).
 *
 * `subtotalesPorConcepto` NO se persiste en este schema — se calcula al vuelo
 * en `ExtractosIaService` a partir de `movimientos` (ver
 * `calcularSubtotalesPorConcepto`). Se decide así porque `movimientos` se
 * puede editar después de la extracción inicial (`actualizarMovimientos`);
 * persistir un subtotal derivado abriría la puerta a que quede desactualizado
 * respecto de los movimientos reales si se olvida recalcularlo en cada
 * edición. Recalcularlo en cada lectura es barato (la cantidad de movimientos
 * de un extracto mensual es chica) y garantiza que nunca esté desincronizado.
 */
@Schema(baseSchemaOptions)
export class ExtractoBancario {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Cliente', required: true, index: true })
  clienteId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'CuentaBancaria', required: true, index: true })
  cuentaBancariaId: Types.ObjectId;

  /** Mes que cubre el extracto, formato "YYYY-MM" — agrupa el extracto para el asiento contable mensual. */
  @Prop({ required: true, trim: true })
  periodo: string;

  @Prop({ required: true, trim: true })
  nombreArchivo: string;

  /**
   * PDF original codificado en base64 — mismo criterio de alcance que
   * `Documento` (portal-clientes) y `TareaAdjunto` (iva-tareas): todavía no
   * hay una solución de storage de objetos confirmada, así que el contenido
   * se guarda directo en Mongo. `select: false` para que no viaje en
   * `GET /extractos-ia` (hasta 100 registros por página) ni en el detalle —
   * solo se trae explícitamente en `obtenerArchivo`, pedido bajo demanda
   * cuando el contador realmente hace clic en "Ver PDF". Extractos cargados
   * antes de este campo quedan sin PDF para ver — limitación conocida, no
   * hay migración retroactiva posible (el archivo original ya se había
   * descartado tras procesarlo).
   */
  @Prop({ select: false })
  archivoBase64?: string;

  @Prop({
    type: String,
    enum: EstadoExtracto,
    required: true,
    default: EstadoExtracto.PENDIENTE,
  })
  estado: EstadoExtracto;

  @Prop({ type: [MovimientoExtractoSchema], default: [] })
  movimientos: MovimientoExtracto[];

  /** Saldo inicial declarado en el encabezado del PDF (extraído por IA, no editable a mano). */
  @Prop()
  saldoInicialDeclarado?: number;

  /** Saldo final declarado al pie del PDF (extraído por IA, no editable a mano). */
  @Prop()
  saldoFinalDeclarado?: number;

  /** Mensaje de error del procesamiento (PDF sin capa de texto, banco no soportado, etc.). */
  @Prop({ trim: true })
  mensajeError?: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;
}

export const ExtractoBancarioSchema = SchemaFactory.createForClass(ExtractoBancario);
ExtractoBancarioSchema.index({ estudioId: 1, clienteId: 1 });
ExtractoBancarioSchema.index({ estudioId: 1, cuentaBancariaId: 1, periodo: 1 });
