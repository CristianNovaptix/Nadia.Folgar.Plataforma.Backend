import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { IvaTareasService } from './iva-tareas.service';
import {
  AlertaTareaEstado,
  AlertaTareaEstadoDocument,
} from './schemas/alerta-tarea-estado.schema';
import { TareaPresentacion, TareaPresentacionDocument } from './schemas/tarea-presentacion.schema';
import { UpdateAlertaTareaDto } from './dto/update-alerta-tarea.dto';

export interface AlertaTarea {
  leida: boolean;
  enPapelera: boolean;
}

/**
 * Centro de notificaciones de la campanita del Inicio: tareas no presentadas
 * vencidas o por vencer (`IvaTareasService.findAlertasVencimiento`) más el
 * estado propio de cada usuario (`AlertaTareaEstado`).
 */
@Injectable()
export class AlertasTareasService {
  constructor(
    private readonly ivaTareasService: IvaTareasService,
    @InjectModel(AlertaTareaEstado.name)
    private readonly estadoModel: Model<AlertaTareaEstadoDocument>,
    @InjectModel(TareaPresentacion.name)
    private readonly tareaModel: Model<TareaPresentacionDocument>,
  ) {}

  async listar(estudioId: Types.ObjectId, userId: Types.ObjectId, horas: number) {
    const tareas = await this.ivaTareasService.findAlertasVencimiento(estudioId, horas);
    const estados = await this.estadoModel
      .find({ userId, tareaId: { $in: tareas.map((t) => t._id) } })
      .exec();
    const estadoPorTarea = new Map(estados.map((e) => [e.tareaId.toString(), e]));

    return tareas.flatMap((tarea) => {
      const estado = estadoPorTarea.get(tarea._id.toString());
      const vigente =
        estado && estado.fechaHasta.getTime() === tarea.fechaHasta?.getTime() ? estado : undefined;
      if (vigente?.eliminada) return [];
      const alerta: AlertaTarea = {
        leida: vigente?.leida ?? false,
        enPapelera: vigente?.enPapelera ?? false,
      };
      return [{ ...tarea.toJSON(), alerta }];
    });
  }

  async actualizar(
    estudioId: Types.ObjectId,
    userId: Types.ObjectId,
    tareaId: string,
    cambios: UpdateAlertaTareaDto & { eliminada?: boolean },
  ): Promise<void> {
    const tarea = await this.tareaModel.findOne({ _id: tareaId, estudioId }).exec();
    if (!tarea?.fechaHasta) {
      throw new NotFoundException('Notificación no encontrada');
    }
    const actual = await this.estadoModel.findOne({ userId, tareaId: tarea._id }).exec();
    const mismoVencimiento = actual?.fechaHasta.getTime() === tarea.fechaHasta.getTime();
    const base = mismoVencimiento
      ? { leida: actual!.leida, enPapelera: actual!.enPapelera, eliminada: actual!.eliminada }
      : { leida: false, enPapelera: false, eliminada: false };

    await this.estadoModel
      .updateOne(
        { userId, tareaId: tarea._id },
        { $set: { ...base, ...cambios, fechaHasta: tarea.fechaHasta } },
        { upsert: true },
      )
      .exec();
  }

  async marcarTodasLeidas(
    estudioId: Types.ObjectId,
    userId: Types.ObjectId,
    horas: number,
  ): Promise<void> {
    const alertas = await this.listar(estudioId, userId, horas);
    await Promise.all(
      alertas
        .filter((a) => !a.alerta.leida && !a.alerta.enPapelera)
        .map((a) => this.actualizar(estudioId, userId, a._id.toString(), { leida: true })),
    );
  }
}
