import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { ResumenClienteService } from './resumen-cliente.service';
import { Cliente } from '../clientes/schemas/cliente.schema';
import { ArcaSincronizacion } from '../arca-sync/schemas/arca-sincronizacion.schema';
import { Factura } from '../facturacion-electronica/schemas/factura.schema';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { TareaPresentacion } from '../iva-tareas/schemas/tarea-presentacion.schema';
import { Vencimiento } from '../notificaciones/schemas/vencimiento.schema';
import { Reunion } from '../inicio/schemas/reunion.schema';
import { PanelClienteMes } from './schemas/panel-cliente-mes.schema';

const query = <T>(valor: T) => {
  const q = {
    sort: jest.fn(),
    lean: jest.fn(),
    populate: jest.fn(),
    exec: jest.fn().mockResolvedValue(valor),
  };
  q.sort.mockReturnValue(q);
  q.lean.mockReturnValue(q);
  q.populate.mockReturnValue(q);
  return q;
};

describe('ResumenClienteService', () => {
  const estudioId = new Types.ObjectId();
  const clienteId = new Types.ObjectId();
  const usuarioCliente: AuthenticatedUser = {
    userId: 'u1',
    email: 'cliente@mail.com',
    roles: ['cliente'],
    permissions: ['portal.documentos.read'],
    estudioId: estudioId.toString(),
    clienteId: clienteId.toString(),
    debeCambiarPassword: false,
  };
  let clienteModel: Record<string, jest.Mock>;
  let syncModel: Record<string, jest.Mock>;
  let facturaModel: Record<string, jest.Mock>;
  let reunionModel: Record<string, jest.Mock>;
  let service: ResumenClienteService;

  beforeEach(async () => {
    clienteModel = {
      findOne: jest.fn(() =>
        query({
          nombre: 'Cliente SA',
          cuit: '30-11111111-1',
          credencialesArca: { usuario: '30111111111', passwordCifrada: 'secreto' },
        }),
      ),
    };
    syncModel = {
      findOne: jest.fn(() =>
        query({
          estado: 'ok',
          datosPorCuit: {
            '30111111111': { comprobantes: [{ tipo: 'venta', importeTotal: 100 }], veps: [] },
          },
        }),
      ),
    };
    facturaModel = {
      find: jest.fn(() =>
        query([{ _id: new Types.ObjectId(), concepto: 'Honorarios', monto: 50, pagada: false }]),
      ),
    };
    reunionModel = { find: jest.fn(() => query([{ titulo: 'Reunión mensual' }])) };
    const modulo = await Test.createTestingModule({
      providers: [
        ResumenClienteService,
        { provide: getModelToken(Cliente.name), useValue: clienteModel },
        { provide: getModelToken(ArcaSincronizacion.name), useValue: syncModel },
        { provide: getModelToken(Factura.name), useValue: facturaModel },
        {
          provide: getModelToken(PanelClienteMes.name),
          useValue: { find: jest.fn(() => query([{ periodo: '2026-11', facturacion: 10 }])) },
        },
        { provide: getModelToken(TareaPresentacion.name), useValue: { find: jest.fn(() => query([])) } },
        { provide: getModelToken(Vencimiento.name), useValue: { find: jest.fn(() => query([])) } },
        { provide: getModelToken(Reunion.name), useValue: reunionModel },
      ],
    }).compile();
    service = modulo.get(ResumenClienteService);
  });

  it('devuelve los datos de ARCA y los honorarios del cliente del token, sin credenciales', async () => {
    const resumen = await service.resumen(usuarioCliente);

    expect(clienteModel.findOne.mock.calls[0][0]).toEqual({ _id: clienteId, estudioId });
    expect(facturaModel.find.mock.calls[0][0]).toEqual({ clienteId, estudioId, estado: 'emitida' });
    expect(resumen.cliente).toEqual({ nombre: 'Cliente SA', cuit: '30-11111111-1' });
    expect(resumen.arca.comprobantes).toEqual([{ tipo: 'venta', importeTotal: 100 }]);
    expect(resumen.arca.veps).toEqual([]);
    expect(resumen.arca.vencimientos).toBeNull();
    expect(resumen.honorarios).toHaveLength(1);
    expect(resumen.panel).toEqual([{ periodo: '2026-11', facturacion: 10 }]);
    // Las reuniones del cliente, las haya creado quien sea, sin las de la papelera.
    expect(reunionModel.find.mock.calls[0][0]).toEqual({
      clienteId,
      estudioId,
      enPapelera: { $ne: true },
    });
    expect(resumen.reuniones).toEqual([{ titulo: 'Reunión mensual' }]);
    expect(JSON.stringify(resumen)).not.toContain('secreto');
  });

  it('rechaza a un usuario que no es del rol cliente', async () => {
    await expect(
      service.resumen({ ...usuarioCliente, roles: ['admin'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
