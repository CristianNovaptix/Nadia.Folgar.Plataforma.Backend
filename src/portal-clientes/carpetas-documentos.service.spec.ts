import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { CarpetasDocumentosService } from './carpetas-documentos.service';
import { CarpetaDocumento } from './schemas/carpeta-documento.schema';
import { Documento } from './schemas/documento.schema';
import { Cliente } from '../clientes/schemas/cliente.schema';

const exec = <T>(valor: T) => ({ exec: jest.fn().mockResolvedValue(valor) });

describe('CarpetasDocumentosService', () => {
  const estudioId = new Types.ObjectId();
  const carpetaId = new Types.ObjectId();
  const subcarpetaId = new Types.ObjectId();
  let carpetaModel: Record<string, jest.Mock>;
  let documentoModel: Record<string, jest.Mock>;
  let service: CarpetasDocumentosService;

  beforeEach(async () => {
    carpetaModel = {
      findOne: jest.fn(() => exec({ _id: carpetaId })),
      // Primer nivel: una subcarpeta; segundo nivel: ninguna.
      find: jest
        .fn()
        .mockReturnValueOnce(exec([{ _id: subcarpetaId }]))
        .mockReturnValueOnce(exec([])),
      deleteMany: jest.fn(() => exec({})),
    };
    documentoModel = { updateMany: jest.fn(() => exec({ modifiedCount: 3 })) };
    const modulo = await Test.createTestingModule({
      providers: [
        CarpetasDocumentosService,
        { provide: getModelToken(CarpetaDocumento.name), useValue: carpetaModel },
        { provide: getModelToken(Documento.name), useValue: documentoModel },
        { provide: getModelToken(Cliente.name), useValue: {} },
      ],
    }).compile();
    service = modulo.get(CarpetasDocumentosService);
  });

  it('elimina la carpeta con sus subcarpetas y manda sus archivos a la papelera', async () => {
    const resultado = await service.eliminar(carpetaId.toString(), estudioId);

    expect(documentoModel.updateMany).toHaveBeenCalledWith(
      { carpetaId: { $in: [carpetaId, subcarpetaId] }, estudioId, enPapelera: { $ne: true } },
      { enPapelera: true, carpetaId: null },
    );
    expect(carpetaModel.deleteMany).toHaveBeenCalledWith({
      _id: { $in: [carpetaId, subcarpetaId] },
      estudioId,
    });
    expect(resultado).toEqual({ documentos: 3, carpetas: 2 });
  });

  it('avisa si la carpeta no existe', async () => {
    carpetaModel.findOne.mockReturnValue(exec(null));
    await expect(service.eliminar(carpetaId.toString(), estudioId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
