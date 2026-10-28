import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, Schema } from 'mongoose';
import { esUsuarioPrueba, registroPruebaContext, registroPruebaPlugin } from './registro-prueba';

describe('registroPruebaPlugin', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = mongoose.createConnection(mongod.getUri());
    connection.plugin(registroPruebaPlugin);
    await connection.asPromise();
  }, 60000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  type Cosa = { nombre?: string; esPrueba?: boolean; items?: { x: number; esPrueba?: boolean }[] };
  const modelo = () =>
    (connection.models.Cosa as mongoose.Model<Cosa> | undefined) ??
    connection.model<Cosa>(
      'Cosa',
      new Schema({ nombre: String, items: [new Schema({ x: Number })] }),
    );

  it('marca lo creado por un usuario de prueba (create e insertMany)', async () => {
    const [creado, insertados] = await registroPruebaContext.run({ esPrueba: true }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return [
        await modelo().create({ nombre: 'a', items: [{ x: 1 }] }),
        await modelo().insertMany([{ nombre: 'b' }]),
      ] as const;
    });
    const enDb = await modelo().findById(creado._id).lean();
    expect(enDb?.esPrueba).toBe(true);
    expect(enDb?.items?.[0].esPrueba).toBeUndefined();
    expect((await modelo().findById(insertados[0]._id).lean())?.esPrueba).toBe(true);
  });

  it('no marca lo creado por otros usuarios ni lo editado después', async () => {
    const real = await registroPruebaContext.run({ esPrueba: false }, () =>
      modelo().create({ nombre: 'real' }),
    );
    await registroPruebaContext.run({ esPrueba: true }, async () => {
      real.nombre = 'editado';
      await real.save();
    });
    expect((await modelo().findById(real._id).lean())?.esPrueba).toBeUndefined();
  });

  it('nunca marca las reglas de clasificación', async () => {
    const Regla = connection.model<{ patronTexto?: string; esPrueba?: boolean }>(
      'ReglaClasificacion',
      new Schema({ patronTexto: String }),
    );
    const [creada, insertadas] = await registroPruebaContext.run({ esPrueba: true }, async () => [
      await Regla.create({ patronTexto: 'a' }),
      await Regla.insertMany([{ patronTexto: 'b' }]),
    ] as const);
    expect((await Regla.findById(creada._id).lean())?.esPrueba).toBeUndefined();
    expect((await Regla.findById(insertadas[0]._id).lean())?.esPrueba).toBeUndefined();
  });

  it('reconoce la cuenta de pruebas por id o por email', () => {
    expect(esUsuarioPrueba({ userId: '6a847bcc4663561cccd91efa', email: 'otro@x.com' })).toBe(true);
    expect(esUsuarioPrueba({ userId: 'x', email: 'Alimayneleb@gmail.com' })).toBe(true);
    expect(esUsuarioPrueba({ userId: 'x', email: 'admin@folgar.com.ar' })).toBe(true);
    expect(esUsuarioPrueba({ userId: 'x', email: 'nadia.folgar@folgar.com.ar' })).toBe(false);
    expect(esUsuarioPrueba(undefined)).toBe(false);
  });
});
