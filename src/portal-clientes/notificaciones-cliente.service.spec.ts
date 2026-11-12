import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { NotificacionesClienteService } from './notificaciones-cliente.service';
import { Comunicado } from './schemas/comunicado.schema';
import { ComunicadoEstado } from './schemas/comunicado-estado.schema';
import { AuthenticatedUser } from '../common/types/authenticated-user';

const query = <T>(valor: T) => {
  const q: Record<string, jest.Mock> = { exec: jest.fn().mockResolvedValue(valor) };
  for (const m of ['sort', 'limit', 'populate', 'lean']) q[m] = jest.fn(() => q);
  return q;
};

describe('NotificacionesClienteService', () => {
  const estudioId = new Types.ObjectId();
  const clienteId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const c1 = new Types.ObjectId();
  const c2 = new Types.ObjectId();
  const usuario: AuthenticatedUser = {
    userId: userId.toString(),
    email: 'c@mail.com',
    roles: ['cliente'],
    permissions: ['portal.documentos.read'],
    estudioId: estudioId.toString(),
    clienteId: clienteId.toString(),
    debeCambiarPassword: false,
  };
  let comunicadoModel: Record<string, jest.Mock>;
  let estadoModel: Record<string, jest.Mock>;
  let service: NotificacionesClienteService;

  beforeEach(async () => {
    comunicadoModel = {
      find: jest.fn(() =>
        query([
          { _id: c1, titulo: 'Uno', cuerpo: 'A' },
          { _id: c2, titulo: 'Dos', cuerpo: 'B' },
        ]),
      ),
      exists: jest.fn(() => ({ exec: jest.fn().mockResolvedValue({ _id: c1 }) })),
    };
    estadoModel = {
      find: jest.fn(() => query([{ comunicadoId: c1, leida: true }, { comunicadoId: c2, eliminada: true }])),
      updateOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue({}) })),
      bulkWrite: jest.fn().mockResolvedValue({}),
    };
    const modulo = await Test.createTestingModule({
      providers: [
        NotificacionesClienteService,
        { provide: getModelToken(Comunicado.name), useValue: comunicadoModel },
        { provide: getModelToken(ComunicadoEstado.name), useValue: estadoModel },
      ],
    }).compile();
    service = modulo.get(NotificacionesClienteService);
  });

  it('lista solo los comunicados del cliente y los generales, con su estado y sin los eliminados', async () => {
    const lista = await service.listar(usuario);

    expect(comunicadoModel.find.mock.calls[0][0]).toEqual({
      estudioId,
      $or: [{ clienteId }, { clienteId: null }],
    });
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ titulo: 'Uno', cuerpo: 'A', leida: true, enPapelera: false });
  });

  it('guarda el estado por usuario', async () => {
    await service.actualizar(c1.toString(), { enPapelera: true }, usuario);
    expect(estadoModel.updateOne).toHaveBeenCalledWith(
      { userId, comunicadoId: c1 },
      { $set: { enPapelera: true } },
      { upsert: true },
    );
  });

  it('no deja tocar un comunicado que el cliente no puede ver', async () => {
    comunicadoModel.exists.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    await expect(service.actualizar(c1.toString(), { leida: true }, usuario)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
