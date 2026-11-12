import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Comunicado, ComunicadoDocument } from './schemas/comunicado.schema';
import { ComunicadoEstado, ComunicadoEstadoDocument } from './schemas/comunicado-estado.schema';

export interface NotificacionComunicado {
  _id: string;
  titulo: string;
  cuerpo: string;
  createdAt?: Date;
  creadoPor?: unknown;
  leida: boolean;
  enPapelera: boolean;
}

/**
 * Campanita del portal del cliente: los comunicados que puede ver (los suyos y los
 * "para todos"), con su estado por usuario (leída / papelera / eliminada).
 */
@Injectable()
export class NotificacionesClienteService {
  constructor(
    @InjectModel(Comunicado.name) private readonly comunicadoModel: Model<ComunicadoDocument>,
    @InjectModel(ComunicadoEstado.name)
    private readonly estadoModel: Model<ComunicadoEstadoDocument>,
  ) {}

  /** Mismo alcance que `PortalClientesService.findComunicadosParaUsuario`. */
  private filtroVisibles(user: AuthenticatedUser): FilterQuery<ComunicadoDocument> {
    const estudioId = new Types.ObjectId(user.estudioId);
    if (!user.roles.includes('cliente')) return { estudioId };
    if (!user.clienteId) return { estudioId, clienteId: null };
    return {
      estudioId,
      $or: [{ clienteId: new Types.ObjectId(user.clienteId) }, { clienteId: null }],
    };
  }

  async listar(user: AuthenticatedUser): Promise<NotificacionComunicado[]> {
    const userId = new Types.ObjectId(user.userId);
    const [comunicados, estados] = await Promise.all([
      this.comunicadoModel
        .find(this.filtroVisibles(user))
        .sort({ createdAt: -1, _id: -1 })
        .limit(100)
        .populate('creadoPor', 'nombre')
        .lean()
        .exec(),
      this.estadoModel.find({ userId }).lean().exec(),
    ]);
    const porComunicado = new Map(estados.map((e) => [e.comunicadoId.toString(), e]));
    return comunicados
      .filter((c) => !porComunicado.get(c._id.toString())?.eliminada)
      .map((c) => {
        const estado = porComunicado.get(c._id.toString());
        return {
          _id: c._id.toString(),
          titulo: c.titulo,
          cuerpo: c.cuerpo,
          createdAt: (c as { createdAt?: Date }).createdAt,
          creadoPor: (c as { creadoPor?: unknown }).creadoPor,
          leida: Boolean(estado?.leida),
          enPapelera: Boolean(estado?.enPapelera),
        };
      });
  }

  async actualizar(
    comunicadoId: string,
    cambios: { leida?: boolean; enPapelera?: boolean; eliminada?: boolean },
    user: AuthenticatedUser,
  ): Promise<void> {
    if (!Types.ObjectId.isValid(comunicadoId)) throw new NotFoundException('Notificación no encontrada');
    const id = new Types.ObjectId(comunicadoId);
    const visible = await this.comunicadoModel
      .exists({ ...this.filtroVisibles(user), _id: id })
      .exec();
    if (!visible) throw new NotFoundException('Notificación no encontrada');
    const set: Record<string, boolean> = {};
    if (cambios.leida !== undefined) set.leida = cambios.leida;
    if (cambios.enPapelera !== undefined) set.enPapelera = cambios.enPapelera;
    if (cambios.eliminada !== undefined) set.eliminada = cambios.eliminada;
    await this.estadoModel
      .updateOne({ userId: new Types.ObjectId(user.userId), comunicadoId: id }, { $set: set }, { upsert: true })
      .exec();
  }

  async marcarTodasLeidas(user: AuthenticatedUser): Promise<void> {
    const userId = new Types.ObjectId(user.userId);
    const visibles = await this.comunicadoModel.find(this.filtroVisibles(user), { _id: 1 }).lean().exec();
    if (visibles.length === 0) return;
    await this.estadoModel.bulkWrite(
      visibles.map((c) => ({
        updateOne: {
          filter: { userId, comunicadoId: c._id },
          update: { $set: { leida: true } },
          upsert: true,
        },
      })),
    );
  }
}
