import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { conDesempatePorId } from '../common/utils/orden-estable';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Cliente, ClienteDocument } from '../clientes/schemas/cliente.schema';
import { PaginatedResult } from '../common/dto/pagination-query.dto';
import {
  FACTURACION_ELECTRONICA_PORT,
  FacturacionElectronicaPort,
} from './ports/facturacion-electronica.port';
import { EstadoFactura, Factura, FacturaDocument } from './schemas/factura.schema';
import { CreateFacturaDto } from './dto/create-factura.dto';
import { AprobarFacturaDto } from './dto/aprobar-factura.dto';
import { RechazarFacturaDto } from './dto/rechazar-factura.dto';
import { QueryFacturaDto } from './dto/query-factura.dto';

@Injectable()
export class FacturacionElectronicaService {
  constructor(
    @InjectModel(Factura.name) private readonly facturaModel: Model<FacturaDocument>,
    @InjectModel(Cliente.name) private readonly clienteModel: Model<ClienteDocument>,
    @Inject(FACTURACION_ELECTRONICA_PORT)
    private readonly facturacionPort: FacturacionElectronicaPort,
  ) {}

  async findAll(
    query: QueryFacturaDto,
    estudioId: Types.ObjectId,
  ): Promise<PaginatedResult<FacturaDocument>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const filter: FilterQuery<FacturaDocument> = { estudioId };
    if (query.estado) filter.estado = query.estado;
    if (query.clienteId) filter.clienteId = new Types.ObjectId(query.clienteId);

    const sort: Record<string, 1 | -1> = query.sortBy
      ? { [query.sortBy]: query.sortDir === 'desc' ? -1 : 1 }
      : { createdAt: -1 };

    const [data, total] = await Promise.all([
      this.facturaModel
        .find(filter)
        .sort(conDesempatePorId(sort))
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('clienteId', 'nombre cuit')
        .exec(),
      this.facturaModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: string, estudioId: Types.ObjectId): Promise<FacturaDocument> {
    const factura = await this.facturaModel.findOne({ _id: id, estudioId }).exec();
    if (!factura) {
      throw new NotFoundException('Factura no encontrada');
    }
    return factura;
  }

  async crearPrefactura(
    dto: CreateFacturaDto,
    estudioId: Types.ObjectId,
  ): Promise<FacturaDocument> {
    const cliente = await this.clienteModel.findOne({ _id: dto.clienteId, estudioId }).exec();
    if (!cliente) {
      throw new NotFoundException('Cliente no encontrado en este estudio');
    }

    return this.facturaModel.create({
      clienteId: cliente._id,
      concepto: dto.concepto,
      monto: dto.monto,
      estado: EstadoFactura.PREFACTURA,
      estudioId,
    });
  }

  /**
   * Facturas ya emitidas y todavía no marcadas como pagadas — es el criterio
   * de "factura anterior impaga" para el bloqueo de FOLGAR-054. Simplificación
   * deliberada: no modela días de mora ni recordatorios, solo "emitida y no
   * pagada". Ajustable acá sin tocar el resto del flujo si el criterio real
   * termina siendo más fino (ej. solo bloquear pasados N días).
   */
  async findFacturasImpagas(
    clienteId: Types.ObjectId,
    estudioId: Types.ObjectId,
  ): Promise<FacturaDocument[]> {
    return this.facturaModel
      .find({ clienteId, estudioId, estado: EstadoFactura.EMITIDA, pagada: false })
      .exec();
  }

  /**
   * Antes de aprobar, verifica que el cliente no tenga facturas emitidas sin
   * pagar (checklist FOLGAR-054). Si las tiene, rechaza la aprobación salvo
   * que se pase `forzarPeseADeuda: true` con una `justificacionExcepcion` —
   * esa excepción queda registrada en la propia factura, auditable.
   */
  async aprobar(
    id: string,
    dto: AprobarFacturaDto,
    aprobadoPor: Types.ObjectId,
    estudioId: Types.ObjectId,
  ): Promise<FacturaDocument> {
    const factura = await this.findOne(id, estudioId);
    if (factura.estado !== EstadoFactura.PREFACTURA) {
      throw new BadRequestException('Solo se puede aprobar una factura en estado prefactura');
    }

    const impagas = await this.findFacturasImpagas(factura.clienteId, estudioId);
    if (impagas.length > 0 && !dto.forzarPeseADeuda) {
      const total = impagas.reduce((acc, f) => acc + f.monto, 0);
      throw new BadRequestException(
        `El cliente tiene ${impagas.length} factura(s) impaga(s) por un total de $${total}. ` +
          'Para aprobar igual, reenviá la solicitud con forzarPeseADeuda=true y una justificación.',
      );
    }

    factura.estado = EstadoFactura.APROBADA;
    factura.aprobadoPor = aprobadoPor;
    if (impagas.length > 0 && dto.forzarPeseADeuda) {
      factura.excepcionBloqueoPorImpagos = true;
      factura.justificacionExcepcion = dto.justificacionExcepcion;
    }

    await factura.save();
    return factura;
  }

  async rechazar(
    id: string,
    dto: RechazarFacturaDto,
    estudioId: Types.ObjectId,
  ): Promise<FacturaDocument> {
    const factura = await this.findOne(id, estudioId);
    if (factura.estado !== EstadoFactura.PREFACTURA) {
      throw new BadRequestException('Solo se puede rechazar una factura en estado prefactura');
    }

    factura.estado = EstadoFactura.RECHAZADA;
    factura.motivoRechazo = dto.motivoRechazo;
    await factura.save();
    return factura;
  }

  /**
   * Emite el comprobante vía el puerto (hoy el adapter stub — ver ADR de
   * Riesgo Alto en CLAUDE.md: nunca se llama a un webservice fiscal real
   * sin confirmar la vía de integración con el cliente).
   */
  async emitir(id: string, estudioId: Types.ObjectId): Promise<FacturaDocument> {
    const factura = await this.findOne(id, estudioId);
    if (factura.estado !== EstadoFactura.APROBADA) {
      throw new BadRequestException('Solo se puede emitir una factura ya aprobada');
    }

    const cliente = await this.clienteModel.findOne({ _id: factura.clienteId, estudioId }).exec();
    if (!cliente) {
      throw new NotFoundException('Cliente no encontrado en este estudio');
    }

    const resultado = await this.facturacionPort.emitirComprobante({
      clienteNombre: cliente.nombre,
      clienteCuit: cliente.cuit,
      concepto: factura.concepto,
      monto: factura.monto,
    });

    if (!resultado.exitoso) {
      throw new BadRequestException(resultado.mensaje ?? 'No se pudo emitir el comprobante');
    }

    factura.estado = EstadoFactura.EMITIDA;
    factura.cae = resultado.cae;
    factura.numeroComprobante = resultado.numeroComprobante;
    factura.fechaEmision = new Date();
    await factura.save();
    return factura;
  }

  async marcarComoPagada(id: string, estudioId: Types.ObjectId): Promise<FacturaDocument> {
    const factura = await this.findOne(id, estudioId);
    factura.pagada = true;
    await factura.save();
    return factura;
  }
}
