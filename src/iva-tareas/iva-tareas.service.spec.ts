import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { IvaTareasService } from './iva-tareas.service';
import { EstadoTarea, Jurisdiccion, TareaPresentacion } from './schemas/tarea-presentacion.schema';
import { TareaAdjunto } from './schemas/tarea-adjunto.schema';
import { Cliente, RegimenFiscal } from '../clientes/schemas/cliente.schema';
import { User } from '../users/schemas/user.schema';
import { PERMISSIONS } from '../common/constants/permissions';
import { DocumentoTextoExtractorService } from './documento-texto-extractor.service';
import { AI_TAREAS_DOCUMENTO_PORT } from './ports/ai-tareas-documento.port';

/** Ninguno de estos tests ejercita `analizarDocumento`/`importarTareasDocumento` — solo hace falta para satisfacer el DI. */
const aiTareasDocumentoPortMock = { analizarDocumento: jest.fn() };

/** Ninguno de estos tests ejercita `findMiembrosDelTablero` — solo hace falta para satisfacer el DI. */
const userModelMock = { find: jest.fn() };

/** Documento mínimo que necesita el fake de Model — deliberadamente laxo (índice `unknown`)
 * para poder representar tanto tareas como clientes sin duplicar el helper. */
interface FakeDoc {
  [key: string]: unknown;
  _id: Types.ObjectId;
}

/**
 * Filtro tipo Mongo simplificado: soporta igualdad exacta (comparando por
 * `String()`, para no distinguir entre `Types.ObjectId` y su versión string)
 * y los operadores `$ne`/`$in` (este último lo usa `enriquecerConAdjuntos`
 * para traer de una sola vez los adjuntos de portada de varias tareas).
 */
function matchesFilter(doc: FakeDoc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && '$ne' in (value as Record<string, unknown>)) {
      return String(doc[key]) !== String((value as { $ne: unknown }).$ne);
    }
    if (value && typeof value === 'object' && '$in' in (value as Record<string, unknown>)) {
      const opciones = (value as { $in: unknown[] }).$in;
      return opciones.some((opcion) => String(doc[key]) === String(opcion));
    }
    return String(doc[key]) === String(value);
  });
}

/**
 * Fake de `Model<TareaPresentacionDocument>` respaldado por un array en
 * memoria — permite probar `generarTareasDelMes` y `moverTarea` de punta a
 * punta (incluida la deduplicación real entre dos llamadas) sin levantar
 * Mongo, en vez de encadenar mocks de cada `.exec()` por separado.
 */
function createFakeTareaModel() {
  const docs: FakeDoc[] = [];

  function create(data: Record<string, unknown>): Promise<FakeDoc> {
    const created: FakeDoc = {
      ...data,
      _id: new Types.ObjectId(),
      save: (): Promise<void> => Promise.resolve(),
    };
    // `enriquecerConAdjuntos` llama `.toObject()` sobre cada tarea — un plano sin las
    // funciones propias del fake alcanza para ese uso.
    created.toObject = (): Record<string, unknown> => {
      const plano: Record<string, unknown> = { ...created };
      delete plano.save;
      delete plano.toObject;
      return plano;
    };
    docs.push(created);
    return Promise.resolve(created);
  }

  function exists(filter: Record<string, unknown>) {
    return {
      exec: (): Promise<{ _id: Types.ObjectId } | null> =>
        Promise.resolve(
          docs.some((d) => matchesFilter(d, filter)) ? { _id: new Types.ObjectId() } : null,
        ),
    };
  }

  function countDocuments(filter: Record<string, unknown>) {
    return {
      exec: (): Promise<number> =>
        Promise.resolve(docs.filter((d) => matchesFilter(d, filter)).length),
    };
  }

  function find(filter: Record<string, unknown>) {
    const query = {
      sort: () => query,
      populate: () => query,
      exec: (): Promise<FakeDoc[]> => Promise.resolve(docs.filter((d) => matchesFilter(d, filter))),
    };
    return query;
  }

  function findOne(filter: Record<string, unknown>) {
    return {
      exec: (): Promise<FakeDoc | null> =>
        Promise.resolve(docs.find((d) => matchesFilter(d, filter)) ?? null),
    };
  }

  function updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
    return {
      exec: (): Promise<void> => {
        const doc = docs.find((d) => matchesFilter(d, filter));
        if (doc) Object.assign(doc, update);
        return Promise.resolve();
      },
    };
  }

  function deleteOne(filter: Record<string, unknown>) {
    return {
      exec: (): Promise<void> => {
        const index = docs.findIndex((d) => matchesFilter(d, filter));
        if (index >= 0) docs.splice(index, 1);
        return Promise.resolve();
      },
    };
  }

  const model = {
    create: jest.fn(create),
    exists: jest.fn(exists),
    countDocuments: jest.fn(countDocuments),
    find: jest.fn(find),
    findOne: jest.fn(findOne),
    updateOne: jest.fn(updateOne),
    deleteOne: jest.fn(deleteOne),
  };

  return { model, docs };
}

/**
 * Fake de `Model<TareaAdjuntoDocument>`, mismo espíritu que
 * `createFakeTareaModel` — respaldado por un array en memoria. Se usa en
 * TODOS los describe de este archivo (aunque la mayoría ni toque adjuntos)
 * porque `IvaTareasService` ahora siempre lo inyecta.
 */
function createFakeAdjuntoModel() {
  const docs: FakeDoc[] = [];

  function create(data: Record<string, unknown>): Promise<FakeDoc> {
    const created: FakeDoc = { ...data, _id: new Types.ObjectId() };
    created.deleteOne = (): Promise<void> => {
      const index = docs.findIndex((d) => d._id.equals(created._id));
      if (index >= 0) docs.splice(index, 1);
      return Promise.resolve();
    };
    docs.push(created);
    return Promise.resolve(created);
  }

  function find(filter: Record<string, unknown>) {
    const query = {
      sort: () => query,
      populate: () => query,
      exec: (): Promise<FakeDoc[]> => Promise.resolve(docs.filter((d) => matchesFilter(d, filter))),
    };
    return query;
  }

  function findOne(filter: Record<string, unknown>) {
    return {
      exec: (): Promise<FakeDoc | null> =>
        Promise.resolve(docs.find((d) => matchesFilter(d, filter)) ?? null),
    };
  }

  function deleteMany(filter: Record<string, unknown>) {
    return {
      exec: (): Promise<void> => {
        for (let i = docs.length - 1; i >= 0; i -= 1) {
          if (matchesFilter(docs[i], filter)) docs.splice(i, 1);
        }
        return Promise.resolve();
      },
    };
  }

  /** Solo se usa para el conteo de adjuntos por tarea en `enriquecerConAdjuntos` — se replica ese agrupamiento a mano sobre los docs en memoria. */
  function aggregate() {
    return {
      exec: (): Promise<{ _id: Types.ObjectId; count: number }[]> => {
        const conteos = new Map<string, number>();
        for (const doc of docs) {
          const key = String(doc.tareaId);
          conteos.set(key, (conteos.get(key) ?? 0) + 1);
        }
        return Promise.resolve(
          Array.from(conteos.entries()).map(([id, count]) => ({
            _id: new Types.ObjectId(id),
            count,
          })),
        );
      },
    };
  }

  const model = {
    create: jest.fn(create),
    find: jest.fn(find),
    findOne: jest.fn(findOne),
    deleteMany: jest.fn(deleteMany),
    aggregate: jest.fn(aggregate),
  };

  return { model, docs };
}

describe('IvaTareasService', () => {
  describe('generarTareasDelMes — evita duplicados', () => {
    let service: IvaTareasService;
    let docs: FakeDoc[];
    const estudioId = new Types.ObjectId();

    const clienteResponsableInscripto: FakeDoc = {
      _id: new Types.ObjectId(),
      regimenFiscal: RegimenFiscal.RESPONSABLE_INSCRIPTO,
      activo: true,
      estudioId,
    };
    const clienteMonotributo: FakeDoc = {
      _id: new Types.ObjectId(),
      regimenFiscal: RegimenFiscal.MONOTRIBUTO,
      activo: true,
      estudioId,
    };

    const clienteModelMock = {
      find: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([clienteResponsableInscripto, clienteMonotributo]),
      }),
    };

    beforeEach(async () => {
      jest.clearAllMocks();
      clienteModelMock.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([clienteResponsableInscripto, clienteMonotributo]),
      });

      const fake = createFakeTareaModel();
      docs = fake.docs;
      const fakeAdjunto = createFakeAdjuntoModel();

      const moduleRef = await Test.createTestingModule({
        providers: [
          IvaTareasService,
          { provide: getModelToken(TareaPresentacion.name), useValue: fake.model },
          { provide: getModelToken(TareaAdjunto.name), useValue: fakeAdjunto.model },
          { provide: getModelToken(Cliente.name), useValue: clienteModelMock },
          { provide: getModelToken(User.name), useValue: userModelMock },
          DocumentoTextoExtractorService,
          { provide: AI_TAREAS_DOCUMENTO_PORT, useValue: aiTareasDocumentoPortMock },
        ],
      }).compile();

      service = moduleRef.get(IvaTareasService);
    });

    it('genera ARCA para todos los clientes y ARBA+AGIP solo para responsable_inscripto', async () => {
      const resultado = await service.generarTareasDelMes('2026-08', estudioId);

      // responsable_inscripto: ARCA+ARBA+AGIP (3) + monotributo: ARCA (1) = 4
      expect(resultado).toEqual({ evaluados: 4, creadas: 4, omitidas: 0 });
      expect(docs).toHaveLength(4);

      const jurisdiccionesDelResponsable = docs
        .filter((d) => String(d.clienteId) === String(clienteResponsableInscripto._id))
        .map((d) => d.jurisdiccion as Jurisdiccion)
        .sort();
      expect(jurisdiccionesDelResponsable).toEqual(
        [Jurisdiccion.ARCA, Jurisdiccion.ARBA, Jurisdiccion.AGIP].sort(),
      );

      const jurisdiccionesDelMonotributo = docs
        .filter((d) => String(d.clienteId) === String(clienteMonotributo._id))
        .map((d) => d.jurisdiccion as Jurisdiccion);
      expect(jurisdiccionesDelMonotributo).toEqual([Jurisdiccion.ARCA]);
    });

    it('no duplica tareas si se llama dos veces para el mismo período (checklist FOLGAR-047)', async () => {
      const primeraCorrida = await service.generarTareasDelMes('2026-08', estudioId);
      expect(primeraCorrida.creadas).toBe(4);
      expect(docs).toHaveLength(4);

      const segundaCorrida = await service.generarTareasDelMes('2026-08', estudioId);

      expect(segundaCorrida).toEqual({ evaluados: 4, creadas: 0, omitidas: 4 });
      expect(docs).toHaveLength(4); // sigue en 4, no se duplicó nada
    });

    it('un período distinto sí genera tareas nuevas (no es un límite global, es por período)', async () => {
      await service.generarTareasDelMes('2026-08', estudioId);
      expect(docs).toHaveLength(4);

      const resultadoSetiembre = await service.generarTareasDelMes('2026-09', estudioId);

      expect(resultadoSetiembre.creadas).toBe(4);
      expect(docs).toHaveLength(8);
    });
  });

  describe('moverTarea', () => {
    let service: IvaTareasService;
    let docs: FakeDoc[];
    const estudioId = new Types.ObjectId();

    const clienteModelMock = { find: jest.fn() };

    let tareaMovida: FakeDoc;
    let otraEnCurso: FakeDoc;

    beforeEach(async () => {
      jest.clearAllMocks();

      const fake = createFakeTareaModel();
      docs = fake.docs;
      const fakeAdjunto = createFakeAdjuntoModel();

      tareaMovida = {
        _id: new Types.ObjectId(),
        estudioId,
        clienteId: new Types.ObjectId(),
        jurisdiccion: Jurisdiccion.ARCA,
        periodo: '2026-08',
        estado: EstadoTarea.PENDIENTE,
        posicion: 0,
        checklist: [],
        save: jest.fn().mockResolvedValue(undefined),
      };
      otraEnCurso = {
        _id: new Types.ObjectId(),
        estudioId,
        clienteId: new Types.ObjectId(),
        jurisdiccion: Jurisdiccion.ARBA,
        periodo: '2026-08',
        estado: EstadoTarea.EN_CURSO,
        posicion: 0,
        checklist: [],
        save: jest.fn().mockResolvedValue(undefined),
      };
      docs.push(tareaMovida, otraEnCurso);

      const moduleRef = await Test.createTestingModule({
        providers: [
          IvaTareasService,
          { provide: getModelToken(TareaPresentacion.name), useValue: fake.model },
          { provide: getModelToken(TareaAdjunto.name), useValue: fakeAdjunto.model },
          { provide: getModelToken(Cliente.name), useValue: clienteModelMock },
          { provide: getModelToken(User.name), useValue: userModelMock },
          DocumentoTextoExtractorService,
          { provide: AI_TAREAS_DOCUMENTO_PORT, useValue: aiTareasDocumentoPortMock },
        ],
      }).compile();

      service = moduleRef.get(IvaTareasService);
    });

    it('persiste el nuevo estado y posición, y reordena la columna destino', async () => {
      const resultado = await service.moverTarea(
        tareaMovida._id.toString(),
        { estado: EstadoTarea.EN_CURSO, posicion: 0 },
        estudioId,
      );

      expect(resultado.estado).toBe(EstadoTarea.EN_CURSO);
      expect(resultado.posicion).toBe(0);
      expect(tareaMovida.save).toHaveBeenCalledTimes(1);

      // la tarjeta que ya estaba en "en_curso" se corrió un lugar
      expect(otraEnCurso.posicion).toBe(1);
    });

    it('reordena la columna de origen al sacar la tarjeta', async () => {
      const otraPendiente: FakeDoc = {
        _id: new Types.ObjectId(),
        estudioId,
        clienteId: new Types.ObjectId(),
        jurisdiccion: Jurisdiccion.AGIP,
        periodo: '2026-08',
        estado: EstadoTarea.PENDIENTE,
        posicion: 1,
        checklist: [],
        save: jest.fn().mockResolvedValue(undefined),
      };
      docs.push(otraPendiente);

      await service.moverTarea(
        tareaMovida._id.toString(),
        { estado: EstadoTarea.EN_CURSO, posicion: 0 },
        estudioId,
      );

      // quedaba sola en "pendiente" tras sacar tareaMovida (posición 0) -> pasa a 0
      expect(otraPendiente.posicion).toBe(0);
    });
  });

  describe('removeTarea', () => {
    let service: IvaTareasService;
    let docs: FakeDoc[];
    const estudioId = new Types.ObjectId();

    const clienteModelMock = { find: jest.fn() };

    let tareaBorrada: FakeDoc;
    let otraPendiente: FakeDoc;

    beforeEach(async () => {
      jest.clearAllMocks();

      const fake = createFakeTareaModel();
      docs = fake.docs;
      const fakeAdjunto = createFakeAdjuntoModel();

      tareaBorrada = {
        _id: new Types.ObjectId(),
        estudioId,
        clienteId: new Types.ObjectId(),
        jurisdiccion: Jurisdiccion.ARCA,
        periodo: '2026-08',
        estado: EstadoTarea.PENDIENTE,
        posicion: 0,
        checklist: [],
      };
      otraPendiente = {
        _id: new Types.ObjectId(),
        estudioId,
        clienteId: new Types.ObjectId(),
        jurisdiccion: Jurisdiccion.ARBA,
        periodo: '2026-08',
        estado: EstadoTarea.PENDIENTE,
        posicion: 1,
        checklist: [],
      };
      docs.push(tareaBorrada, otraPendiente);

      const moduleRef = await Test.createTestingModule({
        providers: [
          IvaTareasService,
          { provide: getModelToken(TareaPresentacion.name), useValue: fake.model },
          { provide: getModelToken(TareaAdjunto.name), useValue: fakeAdjunto.model },
          { provide: getModelToken(Cliente.name), useValue: clienteModelMock },
          { provide: getModelToken(User.name), useValue: userModelMock },
          DocumentoTextoExtractorService,
          { provide: AI_TAREAS_DOCUMENTO_PORT, useValue: aiTareasDocumentoPortMock },
        ],
      }).compile();

      service = moduleRef.get(IvaTareasService);
    });

    it('borra la tarea y renumera las que quedan en la misma columna', async () => {
      await service.removeTarea(tareaBorrada._id.toString(), estudioId);

      expect(docs).toHaveLength(1);
      expect(docs[0]._id.toString()).toBe(otraPendiente._id.toString());
      expect(otraPendiente.posicion).toBe(0);
    });

    it('tira NotFoundException si la tarea no existe (o es de otro estudio)', async () => {
      await expect(service.removeTarea(new Types.ObjectId().toString(), estudioId)).rejects.toThrow(
        'Tarea de presentación no encontrada',
      );
    });
  });

  describe('findMiembrosDelTablero', () => {
    let service: IvaTareasService;
    const estudioId = new Types.ObjectId();

    const rolAdmin = { nombre: 'admin', permisos: Object.values(PERMISSIONS) };
    const rolContador = { nombre: 'contador', permisos: [PERMISSIONS.IVA_TAREAS_READ] };
    const rolSinAcceso = { nombre: 'solo-facturacion', permisos: [PERMISSIONS.FACTURACION_READ] };

    const admin: FakeDoc = {
      _id: new Types.ObjectId(),
      nombre: 'Nadia Admin',
      estudioId,
      activo: true,
      roleIds: [rolAdmin],
    };
    const contadora: FakeDoc = {
      _id: new Types.ObjectId(),
      nombre: 'Contadora Test',
      estudioId,
      activo: true,
      roleIds: [rolContador],
      avatarContentType: 'image/png',
      avatarBase64: 'abc123',
    };
    const sinAcceso: FakeDoc = {
      _id: new Types.ObjectId(),
      nombre: 'Sin Acceso',
      estudioId,
      activo: true,
      roleIds: [rolSinAcceso],
    };
    // Caso real reportado: un integrante de Personal con `estudioId` distinto (dato viejo/migrado
    // sin ese campo consistente) o dado de baja quedaba afuera de este picker aunque siguiera
    // viéndose en "Personal" — ver el comentario en `findMiembrosDelTablero`.
    const otroEstudioInactiva: FakeDoc = {
      _id: new Types.ObjectId(),
      nombre: 'Otro Estudio Inactiva',
      estudioId: new Types.ObjectId(),
      activo: false,
      roleIds: [rolContador],
    };

    const userModel = {
      find: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([admin, contadora, sinAcceso, otroEstudioInactiva]),
      }),
    };

    beforeEach(async () => {
      jest.clearAllMocks();
      userModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([admin, contadora, sinAcceso, otroEstudioInactiva]),
      });

      const moduleRef = await Test.createTestingModule({
        providers: [
          IvaTareasService,
          { provide: getModelToken(TareaPresentacion.name), useValue: {} },
          { provide: getModelToken(TareaAdjunto.name), useValue: {} },
          { provide: getModelToken(Cliente.name), useValue: {} },
          { provide: getModelToken(User.name), useValue: userModel },
          DocumentoTextoExtractorService,
          { provide: AI_TAREAS_DOCUMENTO_PORT, useValue: aiTareasDocumentoPortMock },
        ],
      }).compile();

      service = moduleRef.get(IvaTareasService);
    });

    it('incluye a todo integrante de Personal, sin filtrar por estudioId/activo/rol', async () => {
      const miembros = await service.findMiembrosDelTablero();
      const nombres = miembros.map((m) => m.nombre).sort();
      expect(nombres).toEqual(
        ['Contadora Test', 'Nadia Admin', 'Sin Acceso', 'Otro Estudio Inactiva'].sort(),
      );
    });

    it('arma el avatarDataUrl cuando el usuario tiene foto cargada, y null si no', async () => {
      const miembros = await service.findMiembrosDelTablero();
      expect(miembros.find((m) => m.nombre === 'Contadora Test')?.avatarDataUrl).toBe(
        'data:image/png;base64,abc123',
      );
      expect(miembros.find((m) => m.nombre === 'Nadia Admin')?.avatarDataUrl).toBeNull();
    });
  });

  describe('importarTareasDocumento', () => {
    let service: IvaTareasService;
    let docs: FakeDoc[];
    const estudioId = new Types.ObjectId();
    const clienteId = new Types.ObjectId();

    const clienteModelMock = { exists: jest.fn() };

    beforeEach(async () => {
      jest.clearAllMocks();
      clienteModelMock.exists.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: clienteId }),
      });

      const fake = createFakeTareaModel();
      docs = fake.docs;
      const fakeAdjunto = createFakeAdjuntoModel();

      const moduleRef = await Test.createTestingModule({
        providers: [
          IvaTareasService,
          { provide: getModelToken(TareaPresentacion.name), useValue: fake.model },
          { provide: getModelToken(TareaAdjunto.name), useValue: fakeAdjunto.model },
          { provide: getModelToken(Cliente.name), useValue: clienteModelMock },
          { provide: getModelToken(User.name), useValue: userModelMock },
          DocumentoTextoExtractorService,
          { provide: AI_TAREAS_DOCUMENTO_PORT, useValue: aiTareasDocumentoPortMock },
        ],
      }).compile();

      service = moduleRef.get(IvaTareasService);
    });

    it('crea una tarea por cada tarea del lote, en Pendiente, sin jurisdicción, para el cliente elegido', async () => {
      const resultado = await service.importarTareasDocumento(
        {
          clienteId: clienteId.toString(),
          tareas: [
            { titulo: 'Armar el balance', descripcion: 'Detalle', checklist: ['Paso 1', 'Paso 2'] },
            { titulo: 'Enviar el informe' },
          ],
        },
        estudioId,
      );

      expect(resultado).toEqual({ creadas: 2 });
      expect(docs).toHaveLength(2);
      expect(docs[0]).toMatchObject({
        clienteId,
        titulo: 'Armar el balance',
        descripcion: 'Detalle',
        estado: EstadoTarea.PENDIENTE,
        posicion: 0,
        checklist: [
          { texto: 'Paso 1', completado: false },
          { texto: 'Paso 2', completado: false },
        ],
      });
      expect(docs[0].jurisdiccion).toBeUndefined();
      expect(docs[1]).toMatchObject({ titulo: 'Enviar el informe', posicion: 1, checklist: [] });
    });

    it('tira NotFoundException si el cliente no existe (o es de otro estudio)', async () => {
      clienteModelMock.exists.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      await expect(
        service.importarTareasDocumento(
          { clienteId: new Types.ObjectId().toString(), tareas: [{ titulo: 'x' }] },
          estudioId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('guarda quién confirmó la importación en `creadoPor`, y lo deja sin definir si no se pasa', async () => {
      const usuarioId = new Types.ObjectId();

      await service.importarTareasDocumento(
        { clienteId: clienteId.toString(), tareas: [{ titulo: 'Con creador' }] },
        estudioId,
        usuarioId,
      );
      await service.importarTareasDocumento(
        { clienteId: clienteId.toString(), tareas: [{ titulo: 'Sin creador' }] },
        estudioId,
      );

      expect(docs[0]).toMatchObject({ titulo: 'Con creador', creadoPor: usuarioId });
      expect(docs[1].creadoPor).toBeUndefined();
    });
  });

  describe('createTarea', () => {
    it('guarda quién dio de alta la tarjeta en `creadoPor`', async () => {
      const fake = createFakeTareaModel();
      const fakeAdjunto = createFakeAdjuntoModel();
      const moduleRef = await Test.createTestingModule({
        providers: [
          IvaTareasService,
          { provide: getModelToken(TareaPresentacion.name), useValue: fake.model },
          { provide: getModelToken(TareaAdjunto.name), useValue: fakeAdjunto.model },
          { provide: getModelToken(Cliente.name), useValue: { exists: jest.fn() } },
          { provide: getModelToken(User.name), useValue: userModelMock },
          DocumentoTextoExtractorService,
          { provide: AI_TAREAS_DOCUMENTO_PORT, useValue: aiTareasDocumentoPortMock },
        ],
      }).compile();
      const service = moduleRef.get(IvaTareasService);
      const estudioId = new Types.ObjectId();
      const usuarioId = new Types.ObjectId();

      await service.createTarea(
        {
          clienteId: new Types.ObjectId().toString(),
          jurisdiccion: Jurisdiccion.ARCA,
          periodo: '2026-08',
        },
        estudioId,
        usuarioId,
      );

      expect(fake.docs).toHaveLength(1);
      expect(fake.docs[0].creadoPor).toEqual(usuarioId);
    });
  });

  describe('adjuntos', () => {
    let service: IvaTareasService;
    let docs: FakeDoc[];
    let adjuntoDocs: FakeDoc[];
    const estudioId = new Types.ObjectId();

    const clienteModelMock = { find: jest.fn() };

    let tarea: FakeDoc;

    beforeEach(async () => {
      jest.clearAllMocks();

      const fake = createFakeTareaModel();
      docs = fake.docs;
      const fakeAdjunto = createFakeAdjuntoModel();
      adjuntoDocs = fakeAdjunto.docs;

      tarea = {
        _id: new Types.ObjectId(),
        estudioId,
        clienteId: new Types.ObjectId(),
        jurisdiccion: Jurisdiccion.ARCA,
        periodo: '2026-08',
        estado: EstadoTarea.PENDIENTE,
        posicion: 0,
        checklist: [],
        save: jest.fn().mockResolvedValue(undefined),
      };
      // `findKanban` (vía `enriquecerConAdjuntos`) llama `.toObject()` — ver la misma nota en `createFakeTareaModel`.
      tarea.toObject = (): Record<string, unknown> => {
        const plano: Record<string, unknown> = { ...tarea };
        delete plano.save;
        delete plano.toObject;
        return plano;
      };
      docs.push(tarea);

      const moduleRef = await Test.createTestingModule({
        providers: [
          IvaTareasService,
          { provide: getModelToken(TareaPresentacion.name), useValue: fake.model },
          { provide: getModelToken(TareaAdjunto.name), useValue: fakeAdjunto.model },
          { provide: getModelToken(Cliente.name), useValue: clienteModelMock },
          { provide: getModelToken(User.name), useValue: userModelMock },
          DocumentoTextoExtractorService,
          { provide: AI_TAREAS_DOCUMENTO_PORT, useValue: aiTareasDocumentoPortMock },
        ],
      }).compile();

      service = moduleRef.get(IvaTareasService);
    });

    it('addAdjunto sube el archivo y, si es imagen, lo pone como portada automáticamente', async () => {
      const usuarioId = new Types.ObjectId();

      const adjunto = await service.addAdjunto(
        tarea._id.toString(),
        {
          nombre: 'captura.png',
          contentType: 'image/png',
          contenidoBase64: 'aGVsbG8=',
          tamanioBytes: 5,
        },
        estudioId,
        usuarioId,
      );

      expect(adjunto.nombre).toBe('captura.png');
      expect(String(adjunto.subidoPor)).toBe(usuarioId.toString());
      expect(String(tarea.portadaAdjuntoId)).toBe(adjunto._id.toString());
    });

    it('addAdjunto NO toca la portada si el archivo no es una imagen', async () => {
      await service.addAdjunto(
        tarea._id.toString(),
        {
          nombre: 'balance.pdf',
          contentType: 'application/pdf',
          contenidoBase64: 'aGVsbG8=',
          tamanioBytes: 5,
        },
        estudioId,
      );

      expect(tarea.portadaAdjuntoId).toBeUndefined();
    });

    it('addAdjunto reemplaza tanto una portada de color como una portada de imagen anterior', async () => {
      tarea.portadaColor = '#96602f';

      const primeraImagen = await service.addAdjunto(
        tarea._id.toString(),
        { nombre: 'a.png', contentType: 'image/png', contenidoBase64: 'aGVsbG8=', tamanioBytes: 5 },
        estudioId,
      );
      expect(String(tarea.portadaAdjuntoId)).toBe(primeraImagen._id.toString());
      expect(tarea.portadaColor).toBeUndefined();

      const segundaImagen = await service.addAdjunto(
        tarea._id.toString(),
        { nombre: 'b.png', contentType: 'image/png', contenidoBase64: 'aGVsbG8=', tamanioBytes: 5 },
        estudioId,
      );
      expect(String(tarea.portadaAdjuntoId)).toBe(segundaImagen._id.toString());
    });

    it('findAdjuntos lista los adjuntos de la tarea, más nuevo primero', async () => {
      await service.addAdjunto(
        tarea._id.toString(),
        {
          nombre: 'uno.pdf',
          contentType: 'application/pdf',
          contenidoBase64: 'aGVsbG8=',
          tamanioBytes: 5,
        },
        estudioId,
      );
      await service.addAdjunto(
        tarea._id.toString(),
        {
          nombre: 'dos.pdf',
          contentType: 'application/pdf',
          contenidoBase64: 'aGVsbG8=',
          tamanioBytes: 5,
        },
        estudioId,
      );

      const adjuntos = await service.findAdjuntos(tarea._id.toString(), estudioId);
      expect(adjuntos).toHaveLength(2);
    });

    it('removeAdjunto borra el archivo y, si era la portada, limpia esa referencia', async () => {
      const adjunto = await service.addAdjunto(
        tarea._id.toString(),
        { nombre: 'a.png', contentType: 'image/png', contenidoBase64: 'aGVsbG8=', tamanioBytes: 5 },
        estudioId,
      );
      expect(tarea.portadaAdjuntoId).toBeDefined();

      await service.removeAdjunto(tarea._id.toString(), adjunto._id.toString(), estudioId);

      expect(adjuntoDocs).toHaveLength(0);
      expect(tarea.portadaAdjuntoId).toBeUndefined();
    });

    it('removeAdjunto tira NotFoundException si el adjunto no existe (o es de otra tarea)', async () => {
      await expect(
        service.removeAdjunto(tarea._id.toString(), new Types.ObjectId().toString(), estudioId),
      ).rejects.toThrow(NotFoundException);
    });

    it('findKanban trae adjuntosCount y portadaAdjunto (solo el contenido de la portada) por tarea', async () => {
      await service.addAdjunto(
        tarea._id.toString(),
        { nombre: 'a.png', contentType: 'image/png', contenidoBase64: 'aGVsbG8=', tamanioBytes: 5 },
        estudioId,
      );
      await service.addAdjunto(
        tarea._id.toString(),
        {
          nombre: 'b.pdf',
          contentType: 'application/pdf',
          contenidoBase64: 'aGVsbG8=',
          tamanioBytes: 5,
        },
        estudioId,
      );

      const [item] = await service.findKanban(estudioId, { periodo: '2026-08' });

      expect(item.adjuntosCount).toBe(2);
      expect(item.portadaAdjunto).toEqual({
        contentType: 'image/png',
        contenidoBase64: 'aGVsbG8=',
      });
    });

    it('removeTarea borra en cascada los adjuntos de la tarea eliminada', async () => {
      await service.addAdjunto(
        tarea._id.toString(),
        { nombre: 'a.png', contentType: 'image/png', contenidoBase64: 'aGVsbG8=', tamanioBytes: 5 },
        estudioId,
      );
      expect(adjuntoDocs).toHaveLength(1);

      await service.removeTarea(tarea._id.toString(), estudioId);

      expect(adjuntoDocs).toHaveLength(0);
    });
  });

  describe('analizarDocumento', () => {
    let service: IvaTareasService;
    const documentoTextoExtractorServiceMock = { extraer: jest.fn() };

    beforeEach(async () => {
      jest.clearAllMocks();

      const moduleRef = await Test.createTestingModule({
        providers: [
          IvaTareasService,
          { provide: getModelToken(TareaPresentacion.name), useValue: {} },
          { provide: getModelToken(TareaAdjunto.name), useValue: {} },
          { provide: getModelToken(Cliente.name), useValue: {} },
          { provide: getModelToken(User.name), useValue: {} },
          { provide: DocumentoTextoExtractorService, useValue: documentoTextoExtractorServiceMock },
          { provide: AI_TAREAS_DOCUMENTO_PORT, useValue: aiTareasDocumentoPortMock },
        ],
      }).compile();

      service = moduleRef.get(IvaTareasService);
    });

    it('devuelve las tareas propuestas por la IA cuando el documento es legible', async () => {
      documentoTextoExtractorServiceMock.extraer.mockResolvedValue({
        texto: 'texto del brief',
        legible: true,
      });
      aiTareasDocumentoPortMock.analizarDocumento.mockResolvedValue({
        exitoso: true,
        tareas: [{ titulo: 'Armar el balance', descripcion: 'Detalle', checklist: [] }],
      });

      const resultado = await service.analizarDocumento({
        nombreArchivo: 'brief.pdf',
        contenidoBase64: 'YQ==',
      });

      expect(resultado).toEqual({
        nombreArchivo: 'brief.pdf',
        tareas: [{ titulo: 'Armar el balance', descripcion: 'Detalle', checklist: [] }],
      });
    });

    it('tira BadRequestException si el documento no es legible', async () => {
      documentoTextoExtractorServiceMock.extraer.mockResolvedValue({ texto: '', legible: false });

      await expect(
        service.analizarDocumento({ nombreArchivo: 'vacio.pdf', contenidoBase64: 'YQ==' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('tira BadRequestException si la IA no pudo analizar el documento', async () => {
      documentoTextoExtractorServiceMock.extraer.mockResolvedValue({
        texto: 'texto',
        legible: true,
      });
      aiTareasDocumentoPortMock.analizarDocumento.mockResolvedValue({
        exitoso: false,
        tareas: [],
        mensaje: 'Falló',
      });

      await expect(
        service.analizarDocumento({ nombreArchivo: 'brief.pdf', contenidoBase64: 'YQ==' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
