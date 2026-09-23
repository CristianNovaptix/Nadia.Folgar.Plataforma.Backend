import { Types } from 'mongoose';
import { AlertasTareasService } from './alertas-tareas.service';
import { IvaTareasService } from './iva-tareas.service';

const estudioId = new Types.ObjectId();
const userId = new Types.ObjectId();

function tarea(fechaHasta: Date) {
  const _id = new Types.ObjectId();
  return { _id, fechaHasta, toJSON: () => ({ _id, fechaHasta }) };
}

function exec<T>(value: T) {
  return { exec: jest.fn().mockResolvedValue(value) };
}

describe('AlertasTareasService', () => {
  const fecha = new Date('2026-09-25T00:00:00.000Z');

  function crear(tareas: ReturnType<typeof tarea>[], estados: unknown[]) {
    const ivaTareasService = {
      findAlertasVencimiento: jest.fn().mockResolvedValue(tareas),
    } as unknown as IvaTareasService;
    const estadoModel = {
      find: jest.fn().mockReturnValue(exec(estados)),
      findOne: jest.fn().mockReturnValue(exec(estados[0] ?? null)),
      updateOne: jest.fn().mockReturnValue(exec({})),
    };
    const tareaModel = { findOne: jest.fn().mockReturnValue(exec(tareas[0] ?? null)) };
    const service = new AlertasTareasService(
      ivaTareasService,
      estadoModel as never,
      tareaModel as never,
    );
    return { service, estadoModel };
  }

  it('lista las tareas con su estado por usuario y oculta las eliminadas', async () => {
    const a = tarea(fecha);
    const b = tarea(fecha);
    const { service } = crear(
      [a, b],
      [
        { tareaId: a._id, fechaHasta: fecha, leida: true, enPapelera: false, eliminada: false },
        { tareaId: b._id, fechaHasta: fecha, leida: false, enPapelera: false, eliminada: true },
      ],
    );

    const resultado = await service.listar(estudioId, userId, 48);

    expect(resultado).toHaveLength(1);
    expect(resultado[0].alerta).toEqual({ leida: true, enPapelera: false });
  });

  it('si la tarea cambió de vencimiento, el estado viejo se ignora (notificación nueva)', async () => {
    const a = tarea(fecha);
    const { service } = crear(
      [a],
      [{ tareaId: a._id, fechaHasta: new Date('2026-09-01'), leida: true, enPapelera: true, eliminada: true }],
    );

    const resultado = await service.listar(estudioId, userId, 48);

    expect(resultado[0].alerta).toEqual({ leida: false, enPapelera: false });
  });

  it('mandar a la papelera conserva "leída" y guarda el vencimiento actual', async () => {
    const a = tarea(fecha);
    const { service, estadoModel } = crear(
      [a],
      [{ tareaId: a._id, fechaHasta: fecha, leida: true, enPapelera: false, eliminada: false }],
    );

    await service.actualizar(estudioId, userId, a._id.toString(), { enPapelera: true });

    expect(estadoModel.updateOne).toHaveBeenCalledWith(
      { userId, tareaId: a._id },
      { $set: { leida: true, enPapelera: true, eliminada: false, fechaHasta: fecha } },
      { upsert: true },
    );
  });
});
