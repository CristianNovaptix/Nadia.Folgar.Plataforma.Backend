import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { ArcaSyncService } from './arca-sync.service';
import { ARCA_PORTAL_PORT } from './ports/arca-portal.port';
import { ArcaSincronizacion, ArcaSincronizacionEstado } from './schemas/arca-sincronizacion.schema';
import { Cliente } from '../clientes/schemas/cliente.schema';
import { SecretCipherService } from '../common/crypto/secret-cipher.service';

function exec(result: unknown): any {
  return { exec: jest.fn().mockResolvedValue(result) };
}

describe('ArcaSyncService', () => {
  let service: ArcaSyncService;
  const estudioId = new Types.ObjectId();
  const cliente: any = {
    _id: new Types.ObjectId(),
    nombre: 'Cliente ARCA',
    cuit: '20-11111111-2',
    estudioId,
    credencialesArca: { usuario: '20-11111111-2', passwordCifrada: 'cifrada' },
  };

  const clienteModel: any = { findOne: jest.fn(), find: jest.fn() };
  const sincronizacionModel: any = { updateOne: jest.fn(), findOneAndUpdate: jest.fn(), findOne: jest.fn() };
  const arcaPortal: any = { sincronizar: jest.fn() };
  const secretCipher: any = { decrypt: jest.fn().mockReturnValue('clave-real') };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ArcaSyncService,
        { provide: getModelToken(Cliente.name), useValue: clienteModel },
        { provide: getModelToken(ArcaSincronizacion.name), useValue: sincronizacionModel },
        { provide: ARCA_PORTAL_PORT, useValue: arcaPortal },
        { provide: SecretCipherService, useValue: secretCipher },
      ],
    }).compile();
    service = moduleRef.get(ArcaSyncService);
    clienteModel.findOne.mockReturnValue(exec(cliente));
    sincronizacionModel.updateOne.mockReturnValue(exec(undefined));
    sincronizacionModel.findOneAndUpdate.mockImplementation((_f: unknown, update: any) =>
      exec({ ...update.$set }),
    );
  });

  it('entra con el CUIT solo en dígitos y la clave descifrada, y guarda los datos de cada representado', async () => {
    const datos = { vencimientos: [], deudas: [], comprobantes: null, veps: null, presentaciones: null, notas: {} };
    const contribuyentes = [
      { cuit: '20111111112', nombre: 'CLIENTE ARCA' },
      { cuit: '30222222223', nombre: 'SOCIEDAD REPRESENTADA' },
    ];
    arcaPortal.sincronizar.mockResolvedValue({ contribuyentes, datosPorCuit: { '20111111112': datos, '30222222223': datos } });

    const resumen = await service.sincronizarCliente(cliente._id.toString(), estudioId);

    expect(arcaPortal.sincronizar).toHaveBeenCalledWith({ cuit: '20111111112', password: 'clave-real' });
    expect(resumen.estado).toBe(ArcaSincronizacionEstado.OK);
    expect(resumen.contribuyentes).toEqual(contribuyentes);
    expect(resumen.datosPorCuit['30222222223']).toEqual(datos);
    expect(JSON.stringify(resumen)).not.toContain('clave-real');
  });

  it('si ARCA rechaza la clave, guarda el error sin romper', async () => {
    arcaPortal.sincronizar.mockRejectedValue(new Error('ARCA no aceptó la clave fiscal'));

    const resumen = await service.sincronizarCliente(cliente._id.toString(), estudioId);

    expect(resumen.estado).toBe(ArcaSincronizacionEstado.ERROR);
    expect(resumen.ultimoError).toBe('ARCA no aceptó la clave fiscal');
  });

  it('sin sincronización previa, figura solo el propio cliente y sin datos', async () => {
    sincronizacionModel.findOne.mockReturnValue(exec(null));

    const resumen = await service.findOne(cliente._id.toString(), estudioId);

    expect(resumen.estado).toBe('nunca');
    expect(resumen.contribuyentes).toEqual([{ cuit: '20111111112', nombre: 'Cliente ARCA' }]);
    expect(resumen.datosPorCuit).toEqual({});
  });
});
