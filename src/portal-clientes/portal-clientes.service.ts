import { ClienteHistorialService, TIPO_EVENTO } from '../clientes/cliente-historial.service';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Cliente, ClienteDocument } from '../clientes/schemas/cliente.schema';
import { PaginatedResult } from '../common/dto/pagination-query.dto';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  MESSAGING_PROVIDER,
  MessagingProvider,
} from '../notificaciones/ports/messaging-provider.port';
import { Documento, DocumentoDocument } from './schemas/documento.schema';
import { Comunicado, ComunicadoDocument } from './schemas/comunicado.schema';
import { CreateDocumentoDto } from './dto/create-documento.dto';
import { QueryDocumentoDto } from './dto/query-documento.dto';
import { CreateComunicadoDto } from './dto/create-comunicado.dto';
import { UpdateComunicadoDto } from './dto/update-comunicado.dto';
import { QueryComunicadoDto } from './dto/query-comunicado.dto';

@Injectable()
export class PortalClientesService {
  private readonly logger = new Logger(PortalClientesService.name);

  constructor(
    @InjectModel(Documento.name) private readonly documentoModel: Model<DocumentoDocument>,
    @InjectModel(Comunicado.name) private readonly comunicadoModel: Model<ComunicadoDocument>,
    @InjectModel(Cliente.name) private readonly clienteModel: Model<ClienteDocument>,
    @Inject(MESSAGING_PROVIDER) private readonly messagingProvider: MessagingProvider,
    private readonly historial: ClienteHistorialService,
  ) {}

  // ── Documentos ────────────────────────────────────────────────────────

  /**
   * GARANTÍA DE SEGURIDAD DEL MÓDULO: si `user.roles` incluye 'cliente', el
   * filtro se fuerza a `clienteId: user.clienteId` SIN IMPORTAR qué venga en
   * `query.clienteId`. Un usuario cliente que intente pedir
   * `?clienteId=<otroCliente>` por URL igual solo va a ver lo propio — la
   * validación vive acá, no en el controller, porque es la única garantía
   * real (un controller mal escrito en el futuro no puede saltearla).
   */
  async findDocumentosParaUsuario(
    query: QueryDocumentoDto,
    user: AuthenticatedUser,
  ): Promise<PaginatedResult<DocumentoDocument>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const estudioId = new Types.ObjectId(user.estudioId);

    const filter: FilterQuery<DocumentoDocument> = { estudioId };

    if (user.roles.includes('cliente')) {
      if (!user.clienteId) {
        // Usuario rol cliente sin clienteId asociado en el JWT: no tiene
        // ningún cliente del estudio que representar, no ve nada.
        this.logger.warn(
          `Usuario ${user.userId} tiene rol 'cliente' pero no tiene clienteId asociado`,
        );
        return { data: [], total: 0, page, limit };
      }
      filter.clienteId = new Types.ObjectId(user.clienteId);
    } else if (query.clienteId) {
      filter.clienteId = new Types.ObjectId(query.clienteId);
    }

    const [data, total] = await Promise.all([
      this.documentoModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.documentoModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit };
  }

  async removeDocumento(id: string, estudioId: Types.ObjectId, usuarioId?: string): Promise<void> {
    const documento = await this.documentoModel.findOne({ _id: id, estudioId }).exec();
    if (!documento) {
      throw new NotFoundException('Documento no encontrado');
    }
    await this.historial.registrarCambioDeOrigen(
      documento.clienteId,
      estudioId,
      TIPO_EVENTO.REGISTRO_ELIMINADO,
      `Se eliminó el documento "${documento.nombre}"`,
      usuarioId,
    );
    await documento.deleteOne();
  }

  async createDocumento(
    dto: CreateDocumentoDto,
    estudioId: Types.ObjectId,
  ): Promise<DocumentoDocument> {
    const clienteObjectId = new Types.ObjectId(dto.clienteId);
    const cliente = await this.clienteModel.findOne({ _id: clienteObjectId, estudioId }).exec();
    if (!cliente) {
      throw new NotFoundException('Cliente no encontrado en este estudio');
    }

    const documento = await this.documentoModel.create({
      nombre: dto.nombre,
      contentType: dto.contentType,
      contenidoBase64: dto.contenidoBase64,
      tamanioBytes: dto.tamanioBytes,
      clienteId: clienteObjectId,
      estudioId,
    });

    // El envío de la notificación NUNCA debe hacer fallar el alta del
    // documento — ver `notificarNovedad`, que atrapa cualquier error.
    await this.notificarNovedad(
      cliente,
      'Nuevo documento disponible en tu Portal de Clientes',
      `Hola ${cliente.nombre}, el estudio subió un nuevo documento a tu portal: "${dto.nombre}". Ingresá a tu Portal de Clientes para verlo.`,
    );

    return documento;
  }

  // ── Comunicados ───────────────────────────────────────────────────────

  /**
   * Mismo criterio de seguridad que `findDocumentosParaUsuario`: un usuario
   * rol 'cliente' ve sus propios comunicados MÁS los generales
   * (`clienteId` null/undefined, dirigidos a "todos los clientes"), nunca
   * los de otro cliente puntual — e ignora cualquier `clienteId` que venga
   * en el query. admin/contador ven todos, o filtran por cualquier cliente.
   *
   * Nota Mongo: `{ clienteId: null }` matchea tanto documentos con el campo
   * en `null` como documentos donde el campo no existe, así que alcanza con
   * esa única condición para cubrir "comunicado general".
   */
  async findComunicadosParaUsuario(
    query: QueryComunicadoDto,
    user: AuthenticatedUser,
  ): Promise<PaginatedResult<ComunicadoDocument>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const estudioId = new Types.ObjectId(user.estudioId);

    const filter: FilterQuery<ComunicadoDocument> = { estudioId };

    if (user.roles.includes('cliente')) {
      if (!user.clienteId) {
        this.logger.warn(
          `Usuario ${user.userId} tiene rol 'cliente' pero no tiene clienteId asociado`,
        );
        filter.clienteId = null;
      } else {
        filter.$or = [{ clienteId: new Types.ObjectId(user.clienteId) }, { clienteId: null }];
      }
    } else if (query.clienteId) {
      filter.$or = [{ clienteId: new Types.ObjectId(query.clienteId) }, { clienteId: null }];
    }

    const [data, total] = await Promise.all([
      this.comunicadoModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.comunicadoModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit };
  }

  async createComunicado(
    dto: CreateComunicadoDto,
    estudioId: Types.ObjectId,
  ): Promise<ComunicadoDocument> {
    let cliente: ClienteDocument | null = null;

    if (dto.clienteId) {
      const clienteObjectId = new Types.ObjectId(dto.clienteId);
      cliente = await this.clienteModel.findOne({ _id: clienteObjectId, estudioId }).exec();
      if (!cliente) {
        throw new NotFoundException('Cliente no encontrado en este estudio');
      }
    }

    const comunicado = await this.comunicadoModel.create({
      titulo: dto.titulo,
      cuerpo: dto.cuerpo,
      clienteId: cliente ? cliente._id : undefined,
      estudioId,
    });

    if (cliente) {
      // Solo se notifica cuando el comunicado está dirigido a un cliente
      // puntual (ver consigna de FOLGAR-026). Un comunicado "para todos"
      // (clienteId indefinido) no dispara un envío individual por cliente
      // en este alcance — queda como posible mejora futura (ej. un resumen
      // diario) sin bloquear el alta del comunicado.
      await this.notificarNovedad(
        cliente,
        'Nuevo comunicado del estudio',
        `Hola ${cliente.nombre}, el estudio publicó un nuevo comunicado en tu portal: "${dto.titulo}". Ingresá a tu Portal de Clientes para leerlo.`,
      );
    }

    return comunicado;
  }

  async updateComunicado(
    id: string,
    dto: UpdateComunicadoDto,
    estudioId: Types.ObjectId,
  ): Promise<ComunicadoDocument> {
    const comunicado = await this.comunicadoModel.findOne({ _id: id, estudioId }).exec();
    if (!comunicado) {
      throw new NotFoundException('Comunicado no encontrado');
    }

    if (dto.clienteId !== undefined) {
      if (dto.clienteId) {
        const clienteObjectId = new Types.ObjectId(dto.clienteId);
        const cliente = await this.clienteModel.findOne({ _id: clienteObjectId, estudioId }).exec();
        if (!cliente) {
          throw new NotFoundException('Cliente no encontrado en este estudio');
        }
        comunicado.clienteId = clienteObjectId;
      } else {
        comunicado.clienteId = undefined;
      }
    }

    if (dto.titulo !== undefined) comunicado.titulo = dto.titulo;
    if (dto.cuerpo !== undefined) comunicado.cuerpo = dto.cuerpo;

    await comunicado.save();
    return comunicado;
  }

  async removeComunicado(id: string, estudioId: Types.ObjectId, usuarioId?: string): Promise<void> {
    const comunicado = await this.comunicadoModel.findOne({ _id: id, estudioId }).exec();
    if (!comunicado) {
      throw new NotFoundException('Comunicado no encontrado');
    }
    await this.historial.registrarCambioDeOrigen(
      comunicado.clienteId,
      estudioId,
      TIPO_EVENTO.REGISTRO_ELIMINADO,
      `Se eliminó el comunicado "${comunicado.titulo}"`,
      usuarioId,
    );
    await comunicado.deleteOne();
  }

  // ── Notificaciones (FOLGAR-026) ──────────────────────────────────────

  /**
   * Envía el aviso de novedad vía el puerto `MessagingProvider` (hoy el
   * adapter stub de email, ver `portal-clientes.module.ts`). Atrapa
   * cualquier error deliberadamente: un fallo del canal de notificación
   * (o la ausencia de email cargado) NUNCA debe hacer fallar el alta del
   * documento/comunicado que la disparó.
   */
  private async notificarNovedad(
    cliente: ClienteDocument,
    asunto: string,
    cuerpo: string,
  ): Promise<void> {
    if (!cliente.email) {
      this.logger.warn(
        `No se notificó a "${cliente.nombre}" (${cliente._id.toString()}): no tiene email cargado`,
      );
      return;
    }

    try {
      await this.messagingProvider.sendMessage(cliente.email, `${asunto}\n\n${cuerpo}`);
    } catch (error) {
      this.logger.error(
        `Falló el envío de notificación a "${cliente.nombre}" (${cliente._id.toString()}): ` +
          `${error instanceof Error ? error.message : 'error desconocido'}`,
      );
    }
  }
}
