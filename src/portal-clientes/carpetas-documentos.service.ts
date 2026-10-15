import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Cliente, ClienteDocument } from '../clientes/schemas/cliente.schema';
import { Documento, DocumentoDocument } from './schemas/documento.schema';
import { CarpetaDocumento, CarpetaDocumentoDocument } from './schemas/carpeta-documento.schema';
import {
  CreateCarpetaDocumentoDto,
  QueryCarpetaDocumentoDto,
  UpdateCarpetaDocumentoDto,
} from './dto/carpeta-documento.dto';

/**
 * Carpetas de la "Documentación" de cada cliente (estilo Drive) y mover
 * documentos entre ellas. Mismo scoping que los documentos: el rol 'cliente'
 * solo ve las carpetas de su propio cliente.
 */
@Injectable()
export class CarpetasDocumentosService {
  constructor(
    @InjectModel(CarpetaDocumento.name)
    private readonly carpetaModel: Model<CarpetaDocumentoDocument>,
    @InjectModel(Documento.name) private readonly documentoModel: Model<DocumentoDocument>,
    @InjectModel(Cliente.name) private readonly clienteModel: Model<ClienteDocument>,
  ) {}

  async listar(
    query: QueryCarpetaDocumentoDto,
    user: AuthenticatedUser,
  ): Promise<CarpetaDocumentoDocument[]> {
    const filter: FilterQuery<CarpetaDocumentoDocument> = {
      estudioId: new Types.ObjectId(user.estudioId),
    };
    if (user.roles.includes('cliente')) {
      if (!user.clienteId) return [];
      filter.clienteId = new Types.ObjectId(user.clienteId);
    } else if (query.clienteId) {
      filter.clienteId = new Types.ObjectId(query.clienteId);
    }
    return this.carpetaModel.find(filter).sort({ nombre: 1 }).exec();
  }

  /** La carpeta existe, es del estudio y del mismo cliente. `null`/vacío = raíz. */
  async validarCarpeta(
    carpetaId: string | null | undefined,
    clienteId: Types.ObjectId,
    estudioId: Types.ObjectId,
  ): Promise<Types.ObjectId | null> {
    if (!carpetaId) return null;
    const carpeta = await this.carpetaModel
      .findOne({ _id: carpetaId, estudioId, clienteId })
      .exec();
    if (!carpeta) throw new NotFoundException('Carpeta no encontrada para este cliente');
    return carpeta._id;
  }

  async crear(
    dto: CreateCarpetaDocumentoDto,
    estudioId: Types.ObjectId,
  ): Promise<CarpetaDocumentoDocument> {
    const clienteId = new Types.ObjectId(dto.clienteId);
    const cliente = await this.clienteModel.findOne({ _id: clienteId, estudioId }).exec();
    if (!cliente) throw new NotFoundException('Cliente no encontrado en este estudio');
    const carpetaPadreId = await this.validarCarpeta(dto.carpetaPadreId, clienteId, estudioId);
    return this.carpetaModel.create({ nombre: dto.nombre, carpetaPadreId, clienteId, estudioId });
  }

  async actualizar(
    id: string,
    dto: UpdateCarpetaDocumentoDto,
    estudioId: Types.ObjectId,
  ): Promise<CarpetaDocumentoDocument> {
    const carpeta = await this.carpetaModel.findOne({ _id: id, estudioId }).exec();
    if (!carpeta) throw new NotFoundException('Carpeta no encontrada');
    if (dto.nombre !== undefined) carpeta.nombre = dto.nombre;
    if (dto.carpetaPadreId !== undefined) {
      const nuevoPadre = await this.validarCarpeta(
        dto.carpetaPadreId,
        carpeta.clienteId,
        estudioId,
      );
      // No se puede meter una carpeta dentro de sí misma ni de una de sus subcarpetas.
      for (let actual = nuevoPadre; actual;) {
        if (actual.equals(carpeta._id)) {
          throw new BadRequestException('No se puede mover una carpeta dentro de sí misma');
        }
        const padre = await this.carpetaModel.findById(actual).select('carpetaPadreId').exec();
        actual = padre?.carpetaPadreId ?? null;
      }
      carpeta.carpetaPadreId = nuevoPadre;
    }
    return carpeta.save();
  }

  /**
   * Elimina la carpeta junto con todo su contenido (pedido explícito del
   * usuario): sus subcarpetas se borran y los archivos de adentro van a la
   * papelera de documentos del cliente — mismo criterio que borrar un archivo
   * suelto, así se pueden recuperar si fue sin querer (al restaurarse vuelven
   * a la raíz, porque su carpeta ya no existe). Quien lo pide ya lo confirmó en
   * la pantalla, que muestra cuánto contenido tiene.
   */
  async eliminar(
    id: string,
    estudioId: Types.ObjectId,
  ): Promise<{ documentos: number; carpetas: number }> {
    const carpeta = await this.carpetaModel.findOne({ _id: id, estudioId }).exec();
    if (!carpeta) throw new NotFoundException('Carpeta no encontrada');

    const ids: Types.ObjectId[] = [carpeta._id];
    for (let nivel = [carpeta._id]; nivel.length > 0;) {
      const hijas = await this.carpetaModel
        .find({ carpetaPadreId: { $in: nivel }, estudioId }, { _id: 1 })
        .exec();
      nivel = hijas.map((h) => h._id);
      ids.push(...nivel);
    }

    const enviados = await this.documentoModel
      .updateMany(
        { carpetaId: { $in: ids }, estudioId, enPapelera: { $ne: true } },
        { enPapelera: true, carpetaId: null },
      )
      .exec();
    // Lo que ya estaba en la papelera y venía de estas carpetas, al restaurarse vuelve a la raíz.
    await this.documentoModel
      .updateMany({ carpetaId: { $in: ids }, estudioId }, { carpetaId: null })
      .exec();
    await this.carpetaModel.deleteMany({ _id: { $in: ids }, estudioId }).exec();
    return { documentos: enviados.modifiedCount, carpetas: ids.length };
  }

  async moverDocumento(
    documentoId: string,
    carpetaId: string | null | undefined,
    estudioId: Types.ObjectId,
  ): Promise<DocumentoDocument> {
    const actual = await this.documentoModel
      .findOne({ _id: documentoId, estudioId }, { clienteId: 1 })
      .exec();
    if (!actual) throw new NotFoundException('Documento no encontrado');
    const destino = await this.validarCarpeta(carpetaId, actual.clienteId, estudioId);
    const documento = await this.documentoModel
      .findByIdAndUpdate(
        actual._id,
        { carpetaId: destino },
        { new: true, projection: { contenidoBase64: 0 } },
      )
      .exec();
    if (!documento) throw new NotFoundException('Documento no encontrado');
    return documento;
  }
}
