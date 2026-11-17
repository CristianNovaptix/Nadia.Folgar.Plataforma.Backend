import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { registroPruebaPlugin } from '../common/database/registro-prueba';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { ClienteHistorialService } from '../clientes/cliente-historial.service';
import { Cliente, ClienteDocument, ClienteSchema } from '../clientes/schemas/cliente.schema';
import { User, UserDocument, UserSchema } from '../users/schemas/user.schema';
import { armarHistorialAbonos, estadoDe, estaVencida, FinanzasService } from './finanzas.service';
import {
  fechaDePago,
  inicioDePeriodo,
  mesesEntre,
  periodoDe,
  redondear,
  plazoDePago,
  sumarMeses,
  vencimientoDe,
} from './periodos';
import { AbonoCambio, AbonoCambioDocument, AbonoCambioSchema } from './schemas/abono-cambio.schema';
import {
  DeudaHonorario,
  DeudaHonorarioDocument,
  DeudaHonorarioSchema,
} from './schemas/deuda-honorario.schema';
import {
  HonorarioConfig,
  HonorarioConfigDocument,
  HonorarioConfigSchema,
} from './schemas/honorario-config.schema';

describe('periodos (hora de Argentina)', () => {
  it('el día 1 a la madrugada de Argentina ya es el mes nuevo, aunque en UTC todavía no', () => {
    expect(periodoDe(new Date('2026-12-01T02:00:00Z'))).toBe('2026-11');
    expect(periodoDe(new Date('2026-12-01T03:10:00Z'))).toBe('2026-12');
  });

  it('suma y resta meses cruzando de año', () => {
    expect(sumarMeses('2026-11', 2)).toBe('2027-01');
    expect(sumarMeses('2026-01', -1)).toBe('2025-12');
    expect(sumarMeses('2026-11', -11)).toBe('2025-12');
    expect(mesesEntre('2026-06', '2026-11')).toBe(5);
    expect(mesesEntre('2025-12', '2026-01')).toBe(1);
  });

  it('una fecha de pago sin hora queda en ese mismo día y mes en Argentina', () => {
    expect(periodoDe(fechaDePago('2026-11-01'))).toBe('2026-11');
    expect(periodoDe(fechaDePago('2026-11-30'))).toBe('2026-11');
    expect(inicioDePeriodo('2026-11').toISOString()).toBe('2026-11-01T03:00:00.000Z');
  });

  it('redondea a centavos sin arrastrar errores de coma flotante', () => {
    expect(redondear(0.1 + 0.2)).toBe(0.3);
    expect(redondear(100 - 33.33 - 33.33)).toBe(33.34);
    expect(estadoDe(100, 0)).toBe('pendiente');
    expect(estadoDe(100, 40)).toBe('parcial');
    expect(estadoDe(100, 100)).toBe('pagada');
  });
});

describe('armarHistorialAbonos', () => {
  it('calcula la diferencia y cuántos meses se mantuvo cada monto', () => {
    const historial = armarHistorialAbonos(
      [
        { _id: new Types.ObjectId(), fecha: new Date('2026-01-10T15:00:00Z'), montoNuevo: 50000 },
        {
          _id: new Types.ObjectId(),
          fecha: new Date('2026-06-05T15:00:00Z'),
          montoAnterior: 50000,
          montoNuevo: 53500,
        },
      ],
      new Date('2026-11-13T15:00:00Z'),
    );

    // Del más nuevo al más viejo.
    expect(historial[0]).toMatchObject({
      montoAnterior: 50000,
      montoNuevo: 53500,
      diferencia: 3500,
      mesesMontoAnterior: 5,
      mesesVigente: 5,
      vigente: true,
    });
    expect(historial[1]).toMatchObject({
      montoAnterior: null,
      diferencia: null,
      mesesMontoAnterior: null,
      mesesVigente: 5,
      vigente: false,
    });
  });
});

describe('FinanzasService (base en memoria)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let service: FinanzasService;
  let configModel: Model<HonorarioConfigDocument>;
  let abonoModel: Model<AbonoCambioDocument>;
  let deudaModel: Model<DeudaHonorarioDocument>;
  let clienteModel: Model<ClienteDocument>;
  let userModel: Model<UserDocument>;
  const historial = { registrar: jest.fn().mockResolvedValue(undefined) };

  const estudioId = new Types.ObjectId();
  const contadoraId = new Types.ObjectId();
  const colaboradorId = new Types.ObjectId();
  let clienteA: Types.ObjectId;
  let clienteB: Types.ObjectId;
  let clienteInactivo: Types.ObjectId;

  const usuario = (
    id: Types.ObjectId,
    roles: AuthenticatedUser['roles'],
    permissions: string[],
  ): AuthenticatedUser =>
    ({
      userId: id.toString(),
      email: 'x@folgar.com.ar',
      roles,
      permissions,
      estudioId: estudioId.toString(),
      debeCambiarPassword: false,
    }) as AuthenticatedUser;

  const contadora = usuario(contadoraId, ['admin'], []);
  const colaborador = usuario(colaboradorId, ['contador'], ['finanzas.cobros']);
  const sinPermisos = usuario(new Types.ObjectId(), ['contador'], ['clientes.read']);
  const periodo = periodoDe(new Date());

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = mongoose.createConnection(mongod.getUri());
    connection.plugin(registroPruebaPlugin);
    await connection.asPromise();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelo = (nombre: string, schema: unknown): any =>
      connection.model(nombre, schema as mongoose.Schema);
    configModel = modelo(HonorarioConfig.name, HonorarioConfigSchema);
    abonoModel = modelo(AbonoCambio.name, AbonoCambioSchema);
    deudaModel = modelo(DeudaHonorario.name, DeudaHonorarioSchema);
    clienteModel = modelo(Cliente.name, ClienteSchema);
    userModel = modelo(User.name, UserSchema);
    await Promise.all([deudaModel.init(), configModel.init()]);
    service = new FinanzasService(
      configModel,
      abonoModel,
      deudaModel,
      clienteModel,
      userModel,
      historial as unknown as ClienteHistorialService,
    );
  }, 120000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all(
      [configModel, abonoModel, deudaModel, clienteModel, userModel].map((m) =>
        m.collection.deleteMany({}),
      ),
    );
    await userModel.collection.insertMany([
      { _id: contadoraId, nombre: 'Nadia Folgar', estudioId, activo: true },
      { _id: colaboradorId, nombre: 'Daiana', estudioId, activo: true },
      { nombre: 'Usuario de portal', estudioId, activo: true, clienteId: new Types.ObjectId() },
    ]);
    clienteA = new Types.ObjectId();
    clienteB = new Types.ObjectId();
    clienteInactivo = new Types.ObjectId();
    await clienteModel.collection.insertMany([
      {
        _id: clienteA,
        nombre: 'Alfa SA',
        cuit: '30-1',
        activo: true,
        estudioId,
        responsableIds: [colaboradorId],
      },
      {
        _id: clienteB,
        nombre: 'Beta SRL',
        cuit: '30-2',
        activo: true,
        estudioId,
        responsableIds: [],
      },
      {
        _id: clienteInactivo,
        nombre: 'Gama',
        cuit: '30-3',
        activo: false,
        estudioId,
        responsableIds: [],
      },
    ]);
  });

  /** Deja el abono como si se hubiera cargado antes de empezar el mes. */
  const abonoViejo = (clienteId: Types.ObjectId) =>
    configModel.updateOne(
      { clienteId },
      { $set: { abonoDesde: new Date(inicioDePeriodo(periodo).getTime() - 1000) } },
    );

  it('guarda el abono, quién factura y el día, y deja el historial de cada cambio', async () => {
    const primero = await service.guardar(
      clienteA.toString(),
      { abono: 50000, facturadorId: colaboradorId.toString(), diaEmision: 5 },
      contadora,
    );
    expect(primero).toMatchObject({
      abono: 50000,
      diaEmision: 5,
      facturador: { nombre: 'Daiana' },
    });
    expect(primero.historialAbonos).toHaveLength(1);
    expect(primero.historialAbonos[0]).toMatchObject({
      montoAnterior: null,
      montoNuevo: 50000,
      usuarioNombre: 'Nadia Folgar',
    });

    const segundo = await service.guardar(clienteA.toString(), { abono: 53500 }, contadora);
    expect(segundo.historialAbonos).toHaveLength(2);
    expect(segundo.historialAbonos[0]).toMatchObject({
      montoAnterior: 50000,
      montoNuevo: 53500,
      diferencia: 3500,
      vigente: true,
    });
    // Sin mandar quién factura ni el día, no se pierden.
    expect(segundo).toMatchObject({ diaEmision: 5, facturador: { nombre: 'Daiana' } });

    // Guardar el mismo monto no inventa un cambio.
    const tercero = await service.guardar(clienteA.toString(), { abono: 53500 }, contadora);
    expect(tercero.historialAbonos).toHaveLength(2);

    const tipos = historial.registrar.mock.calls.map((c) => c[2].tipo);
    expect(tipos).toEqual(['honorario_abono', 'honorario_config', 'honorario_abono']);
  });

  it('solo acepta como "quién factura" a un integrante de Personal', async () => {
    const portal = await userModel.findOne({ nombre: 'Usuario de portal' }).lean();
    await expect(
      service.guardar(
        clienteA.toString(),
        { abono: 100, facturadorId: portal!._id.toString() },
        contadora,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((await service.facturadores(contadora)).map((f) => f.nombre)).toEqual([
      'Daiana',
      'Nadia Folgar',
    ]);
  });

  it('el día 1 genera la deuda de cada cliente activo con abono, una sola vez', async () => {
    await service.guardar(clienteA.toString(), { abono: 50000, diaEmision: 5 }, contadora);
    await service.guardar(clienteB.toString(), { abono: 30000 }, contadora);
    await service.guardar(clienteInactivo.toString(), { abono: 10000 }, contadora);
    await Promise.all([abonoViejo(clienteA), abonoViejo(clienteInactivo)]);

    await service.generarDeudasCron();
    await service.generarDeudasCron();

    const deudas = await deudaModel.find().lean();
    // B cargó el abono a mitad de mes (no entra hasta el mes que viene) y el inactivo no genera.
    expect(deudas).toHaveLength(1);
    expect(deudas[0]).toMatchObject({
      periodo,
      monto: 50000,
      pagado: 0,
      estado: 'pendiente',
      diaEmision: 5,
      origen: 'automatica',
    });
    expect(deudas[0].clienteId.toString()).toBe(clienteA.toString());
  });

  it('cambiar el abono no toca la deuda ya generada', async () => {
    await service.guardar(clienteA.toString(), { abono: 50 }, contadora);
    await service.generarDeudasManual(periodo, clienteA.toString(), contadora);
    await service.guardar(clienteA.toString(), { abono: 70 }, contadora);

    const detalle = await service.detalle(clienteA.toString(), contadora);
    expect(detalle.abono).toBe(70);
    expect(detalle.deudas[0].monto).toBe(50);
  });

  it('la generación manual avisa si falta el abono, si ya existe o si el mes no empezó', async () => {
    await expect(
      service.generarDeudasManual(periodo, clienteA.toString(), contadora),
    ).rejects.toThrow('Primero cargá el abono');
    await service.guardar(clienteA.toString(), { abono: 100 }, contadora);
    await service.guardar(clienteB.toString(), { abono: 200 }, contadora);

    expect(await service.generarDeudasManual(periodo, clienteA.toString(), contadora)).toEqual({
      creadas: 1,
      yaExistian: 0,
    });
    await expect(
      service.generarDeudasManual(periodo, clienteA.toString(), contadora),
    ).rejects.toThrow('ya tiene generada');
    // Sin cliente: genera las que falten del estudio.
    expect(await service.generarDeudasManual(periodo, undefined, contadora)).toEqual({
      creadas: 1,
      yaExistian: 1,
    });
    await expect(
      service.generarDeudasManual(sumarMeses(periodo, 1), undefined, contadora),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('acepta pagos parciales y totales, rechaza de más y permite anular sin borrar', async () => {
    await service.guardar(clienteA.toString(), { abono: 100 }, contadora);
    await service.generarDeudasManual(periodo, clienteA.toString(), contadora);
    const deudaId = (await deudaModel.findOne().lean())!._id.toString();

    let detalle = await service.registrarPago(
      deudaId,
      { monto: 33.33, nota: ' seña ' },
      colaborador,
    );
    expect(detalle.deudas[0]).toMatchObject({ pagado: 33.33, saldo: 66.67, estado: 'parcial' });
    expect(detalle.deudas[0].pagos[0]).toMatchObject({
      monto: 33.33,
      medio: 'transferencia',
      nota: 'seña',
      registradoPorNombre: 'Daiana',
      anulado: false,
    });

    await expect(service.registrarPago(deudaId, { monto: 66.68 }, contadora)).rejects.toThrow(
      'supera lo que falta cobrar',
    );
    await expect(
      service.registrarPago(deudaId, { monto: 10, fecha: '2999-01-01' }, contadora),
    ).rejects.toThrow('futura');

    detalle = await service.registrarPago(
      deudaId,
      { monto: 66.67, medio: 'efectivo' as never },
      contadora,
    );
    expect(detalle.deudas[0]).toMatchObject({ pagado: 100, saldo: 0, estado: 'pagada' });
    expect(detalle.deudas[0].fechaCompletada).toBeInstanceOf(Date);
    expect(detalle.saldoPendiente).toBe(0);
    await expect(service.registrarPago(deudaId, { monto: 1 }, contadora)).rejects.toThrow(
      'ya está pagada',
    );

    const pagoId = detalle.deudas[0].pagos.find((p) => p.monto === 66.67)!._id;
    detalle = await service.anularPago(deudaId, pagoId, { motivo: 'Cargado dos veces' }, contadora);
    expect(detalle.deudas[0]).toMatchObject({ pagado: 33.33, saldo: 66.67, estado: 'parcial' });
    expect(detalle.deudas[0].fechaCompletada).toBeNull();
    // El pago anulado sigue guardado, con quién y por qué.
    expect(detalle.deudas[0].pagos).toHaveLength(2);
    expect(detalle.deudas[0].pagos.find((p) => p._id === pagoId)).toMatchObject({
      anulado: true,
      anuladoPorNombre: 'Nadia Folgar',
      motivoAnulacion: 'Cargado dos veces',
    });
    await expect(
      service.anularPago(deudaId, pagoId, { motivo: 'Otra vez' }, contadora),
    ).rejects.toThrow('ya estaba anulado');

    const tipos = historial.registrar.mock.calls.map((c) => c[2].tipo);
    expect(tipos).toEqual([
      'honorario_abono',
      'honorario_deuda',
      'honorario_pago',
      'honorario_pago',
      'honorario_pago_anulado',
    ]);
  });

  it('un pago del cliente cancela primero lo más viejo y lo que sobra queda a favor', async () => {
    await service.guardar(clienteA.toString(), { abono: 100 }, contadora);
    const anterior = sumarMeses(periodo, -1);
    await deudaModel.collection.insertOne({
      clienteId: clienteA,
      estudioId,
      periodo: anterior,
      monto: 80,
      pagado: 0,
      estado: 'pendiente',
      pagos: [],
      origen: 'manual',
    });
    await service.generarDeudasManual(periodo, clienteA.toString(), contadora);

    // Paga 120: 80 del mes viejo y 40 del mes en curso.
    let detalle = await service.registrarPagoCliente(
      clienteA.toString(),
      { monto: 120, medio: 'efectivo' as never },
      colaborador,
    );
    const porMes = (p: string) => detalle.deudas.find((d) => d.periodo === p)!;
    expect(porMes(anterior)).toMatchObject({ pagado: 80, estado: 'pagada' });
    expect(porMes(periodo)).toMatchObject({ pagado: 40, saldo: 60, estado: 'parcial' });
    expect(detalle.saldoAFavor).toBe(0);

    // Paga 200: 60 cierran el mes y 140 quedan a favor (pago adelantado).
    detalle = await service.registrarPagoCliente(clienteA.toString(), { monto: 200 }, contadora);
    expect(porMes(periodo)).toMatchObject({ pagado: 100, estado: 'pagada' });
    expect(detalle).toMatchObject({ saldoPendiente: 0, saldoAFavor: 140 });
    expect(detalle.adelantos[0]).toMatchObject({ monto: 140, disponible: 140, anulado: false });
    const fila = (await service.listar(contadora)).clientes.find(
      (c) => c.cliente.nombre === 'Alfa SA',
    )!;
    expect(fila.saldoAFavor).toBe(140);
    // Lo adelantado cuenta como plata que entró este mes.
    const m = await service.metricas(contadora);
    expect(m.mes.ingresado).toBe(320);
    expect(m.saldoAFavorTotal).toBe(140);

    // La deuda del mes siguiente nace con el adelanto ya descontado.
    const siguiente = sumarMeses(periodo, 1);
    await service.generarDeudas(siguiente, { origen: 'automatica' });
    detalle = await service.detalle(clienteA.toString(), contadora);
    expect(porMes(siguiente)).toMatchObject({ monto: 100, pagado: 100, estado: 'pagada' });
    expect(porMes(siguiente).pagos[0].nota).toContain('Pago adelantado del');
    expect(detalle.saldoAFavor).toBe(40);
    expect(detalle.adelantos[0]).toMatchObject({ monto: 140, disponible: 40 });

    // Lo que no se usó se puede anular (nunca borrar), una sola vez.
    const adelantoId = detalle.adelantos[0]._id;
    detalle = await service.anularAdelanto(
      clienteA.toString(),
      adelantoId,
      { motivo: 'Se devolvió' },
      contadora,
    );
    expect(detalle.saldoAFavor).toBe(0);
    expect(detalle.adelantos[0]).toMatchObject({
      anulado: true,
      montoAnulado: 40,
      motivoAnulacion: 'Se devolvió',
    });
    await expect(
      service.anularAdelanto(clienteA.toString(), adelantoId, { motivo: 'Otra' }, contadora),
    ).rejects.toThrow('ya estaba anulado');

    // Sin ninguna deuda pendiente, todo el pago queda a favor.
    detalle = await service.registrarPagoCliente(clienteB.toString(), { monto: 50 }, contadora);
    expect(detalle).toMatchObject({ abono: 0, saldoAFavor: 50 });
  });

  it('el colaborador solo ve y cobra a los clientes que tiene a cargo', async () => {
    await service.guardar(clienteA.toString(), { abono: 100 }, contadora);
    await service.guardar(clienteB.toString(), { abono: 200 }, contadora);
    await service.generarDeudasManual(periodo, undefined, contadora);
    const deudaB = (await deudaModel.findOne({ clienteId: clienteB }).lean())!._id.toString();

    const propio = await service.listar(colaborador);
    expect(propio.clientes.map((c) => c.cliente.nombre)).toEqual(['Alfa SA']);
    expect(propio.clientes[0]).toMatchObject({
      abono: 100,
      saldoPendiente: 100,
      periodosAdeudados: 1,
      deudaActual: { estado: 'pendiente' },
    });
    expect((await service.listar(contadora)).clientes).toHaveLength(3);

    await expect(service.detalle(clienteB.toString(), colaborador)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.registrarPago(deudaB, { monto: 1 }, colaborador)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.listar(sinPermisos)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.detalle(clienteA.toString(), sinPermisos)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('arma las métricas generales con clientes, abonos, cobranza y deuda', async () => {
    await service.guardar(
      clienteA.toString(),
      { abono: 100, facturadorId: colaboradorId.toString() },
      contadora,
    );
    await service.guardar(clienteB.toString(), { abono: 300 }, contadora);
    await service.generarDeudasManual(periodo, undefined, contadora);
    // Una deuda vieja de B, de hace 3 meses, sin pagar.
    await deudaModel.create({
      clienteId: clienteB,
      estudioId,
      periodo: sumarMeses(periodo, -3),
      monto: 250,
      pagado: 0,
    });
    const deudaA = (await deudaModel.findOne({ clienteId: clienteA }).lean())!._id.toString();
    await service.registrarPago(deudaA, { monto: 40 }, contadora);

    const m = await service.metricas(contadora);
    expect(m.clientes).toEqual({ activos: 2, inactivos: 1, conAbono: 2, sinAbono: 0 });
    expect(m.abonoMensualTotal).toBe(400);
    expect(m.abonoPromedio).toBe(200);
    expect(m.mes).toEqual({ generado: 400, cobrado: 40, pendiente: 360, ingresado: 40 });
    expect(m.deudaTotal).toBe(610);
    expect(m.deudaAtrasada).toBe(250);
    expect(m.clientesConDeuda).toBe(2);
    expect(m.antiguedad.map((t) => t.monto)).toEqual([360, 0, 0, 250]);
    expect(m.deudores[0]).toMatchObject({ nombre: 'Beta SRL', saldo: 550, periodos: 2 });
    // Desde enero del año anterior hasta el mes en curso.
    // Arranca en el primer mes con datos (la deuda de hace 3 meses), no en meses vacíos.
    expect(m.evolucion).toHaveLength(4);
    expect(m.evolucion[0].periodo).toBe(sumarMeses(periodo, -3));
    // Sin ningún dato, queda solo el mes en curso.
    await deudaModel.collection.deleteMany({});
    expect((await service.metricas(contadora)).evolucion.map((e) => e.periodo)).toEqual([periodo]);
    expect(m.detalleClientes.map((c) => c.nombre)).toEqual(['Alfa SA', 'Beta SRL', 'Gama']);
    expect(m.detalleClientes[0]).toMatchObject({
      activo: true,
      abono: 100,
      facturador: 'Daiana',
      saldo: 60,
      periodosAdeudados: 1,
      mesGenerado: 100,
      mesCobrado: 40,
    });
    expect(m.detalleClientes[2]).toMatchObject({ activo: false, abono: 0, mesGenerado: null });
    expect(m.evolucion.at(-1)).toMatchObject({
      periodo,
      generado: 400,
      cobrado: 40,
      cobradoDelPeriodo: 40,
    });
    // Cada mes trae su deuda cliente por cliente, para poder mirar meses anteriores.
    expect(
      [...m.evolucion.at(-1)!.clientes].sort((a, b) => a.nombre.localeCompare(b.nombre)),
    ).toEqual([
      { clienteId: clienteA.toString(), nombre: 'Alfa SA', generado: 100, cobrado: 40 },
      { clienteId: clienteB.toString(), nombre: 'Beta SRL', generado: 300, cobrado: 0 },
    ]);
    expect(m.evolucion.at(-4)).toMatchObject({ generado: 250, cobrado: 0, cobradoDelPeriodo: 0 });
    expect(m.evolucion.at(-4)!.clientes).toEqual([
      { clienteId: clienteB.toString(), nombre: 'Beta SRL', generado: 250, cobrado: 0 },
    ]);
    expect(m.porFacturador).toEqual([
      { nombre: 'Sin asignar', clientes: 1, abonoTotal: 300 },
      { nombre: 'Daiana', clientes: 1, abonoTotal: 100 },
    ]);
  });

  it('calcula el vencimiento del mes y no deja que una deuda nazca vencida', () => {
    expect(vencimientoDe('2026-11', 10).toISOString()).toBe('2026-11-11T02:59:59.000Z');
    // Febrero no tiene día 31: vence el último día del mes.
    expect(vencimientoDe('2027-02', 31).toISOString()).toBe('2027-03-01T02:59:59.000Z');
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const maniana = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(estaVencida({ monto: 100, pagado: 0, fechaVencimiento: ayer })).toBe(true);
    expect(estaVencida({ monto: 100, pagado: 100, fechaVencimiento: ayer })).toBe(false);
    expect(estaVencida({ monto: 100, pagado: 0, fechaVencimiento: maniana })).toBe(false);
    expect(estaVencida({ monto: 100, pagado: 0 })).toBe(false);
  });

  it('por defecto todos pagan del 1 al 10, y cada cliente puede tener su propio plazo', async () => {
    expect(plazoDePago('2026-11', 1, 10)).toEqual({
      inicio: new Date('2026-11-01T03:00:00.000Z'),
      fin: new Date('2026-11-11T02:59:59.000Z'),
    });
    // Del 15 al 5: vence el mes siguiente.
    expect(plazoDePago('2026-12', 15, 5).fin.toISOString()).toBe('2027-01-06T02:59:59.000Z');

    // Sin tocar nada del plazo, vale el de por defecto.
    let detalle = await service.guardar(clienteA.toString(), { abono: 100 }, contadora);
    expect(detalle).toMatchObject({ diaInicioPago: 1, diaVencimiento: 10 });
    const filaB = (await service.listar(contadora)).clientes.find(
      (c) => c.cliente.nombre === 'Beta SRL',
    )!;
    expect(filaB).toMatchObject({ diaInicioPago: 1, diaVencimiento: 10 });

    // Un cliente puntual paga del 15 al 20; los demás no cambian.
    detalle = await service.guardar(
      clienteA.toString(),
      { abono: 100, diaInicioPago: 15, diaVencimiento: 20 },
      contadora,
    );
    expect(detalle).toMatchObject({ diaInicioPago: 15, diaVencimiento: 20 });
    const listado = await service.listar(contadora);
    expect(listado.clientes.find((c) => c.cliente.nombre === 'Beta SRL')).toMatchObject({
      diaInicioPago: 1,
      diaVencimiento: 10,
    });

    // La deuda del día 1 nace con ese plazo.
    await abonoViejo(clienteA);
    await service.generarDeudasCron();
    const deuda = (await deudaModel.findOne().lean())!;
    const inicio = new Date(deuda.fechaInicioPago!);
    const fin = new Date(deuda.fechaVencimiento!);
    const diaAR = (f: Date) =>
      Number(
        f.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).slice(8),
      );
    expect(diaAR(inicio)).toBe(15);
    expect(diaAR(fin)).toBe(20);
    expect(fin.getTime()).toBeGreaterThan(inicio.getTime());

    // Volver al plazo de por defecto.
    detalle = await service.guardar(
      clienteA.toString(),
      { abono: 100, diaInicioPago: null, diaVencimiento: null },
      contadora,
    );
    expect(detalle).toMatchObject({ diaInicioPago: 1, diaVencimiento: 10 });
  });

  it('la deuda se genera con su vencimiento y, pasado el plazo, figura vencida', async () => {
    await service.guardar(clienteA.toString(), { abono: 100, diaVencimiento: 10 }, contadora);
    expect((await service.detalle(clienteA.toString(), contadora)).diaVencimiento).toBe(10);
    await service.generarDeudasManual(periodo, clienteA.toString(), contadora);

    let detalle = await service.detalle(clienteA.toString(), contadora);
    // El plazo es siempre el del mes de la deuda, aunque se genere con el mes avanzado.
    expect(new Date(detalle.deudas[0].fechaInicioPago!)).toEqual(plazoDePago(periodo, 1, 10).inicio);
    expect(new Date(detalle.deudas[0].fechaVencimiento!)).toEqual(plazoDePago(periodo, 1, 10).fin);
    await deudaModel.updateOne({}, { $set: { fechaVencimiento: new Date(Date.now() + 60000) } });
    detalle = await service.detalle(clienteA.toString(), contadora);
    expect(detalle.deudas[0].vencida).toBe(false);
    expect(detalle.saldoVencido).toBe(0);

    // Pasó el plazo sin pagar.
    await deudaModel.updateOne({}, { $set: { fechaVencimiento: new Date(Date.now() - 1000) } });
    detalle = await service.detalle(clienteA.toString(), contadora);
    expect(detalle.deudas[0].vencida).toBe(true);
    expect(detalle.saldoVencido).toBe(100);
    const fila = (await service.listar(contadora)).clientes.find(
      (c) => c.cliente.nombre === 'Alfa SA',
    )!;
    expect(fila).toMatchObject({
      diaVencimiento: 10,
      saldoVencido: 100,
      deudaActual: { vencida: true },
    });
    const m = await service.metricas(contadora);
    expect(m.deudaVencida).toBe(100);
    expect(m.detalleClientes[0]).toMatchObject({ nombre: 'Alfa SA', saldoVencido: 100 });

    // Al saldarla deja de estar vencida.
    await service.registrarPago(detalle.deudas[0]._id, { monto: 100 }, contadora);
    detalle = await service.detalle(clienteA.toString(), contadora);
    expect(detalle.deudas[0].vencida).toBe(false);
    expect((await service.metricas(contadora)).deudaVencida).toBe(0);
  });

  it('en la deuda de un mes se puede cambiar quién factura y correr el vencimiento, sin tocar los demás meses', async () => {
    await service.guardar(
      clienteA.toString(),
      { abono: 100, facturadorId: colaboradorId.toString(), diaVencimiento: 10 },
      contadora,
    );
    await service.generarDeudasManual(periodo, clienteA.toString(), contadora);
    const deudaId = (await deudaModel.findOne().lean())!._id.toString();
    jest.clearAllMocks();

    const detalle = await service.actualizarDeuda(
      deudaId,
      { facturadorId: contadoraId.toString(), fechaVencimiento: '2030-01-15' },
      contadora,
    );
    expect(detalle.deudas[0].facturador).toMatchObject({ nombre: 'Nadia Folgar' });
    expect(new Date(detalle.deudas[0].fechaVencimiento!).toISOString()).toBe(
      '2030-01-16T02:59:59.000Z',
    );
    // Lo cargado para los meses siguientes sigue igual.
    expect(detalle.facturador).toMatchObject({ nombre: 'Daiana' });
    expect(detalle.diaVencimiento).toBe(10);
    expect(historial.registrar).toHaveBeenCalledTimes(1);

    // Sin cambios reales no ensucia el historial; y solo acepta gente de Personal.
    await service.actualizarDeuda(deudaId, { facturadorId: contadoraId.toString() }, contadora);
    expect(historial.registrar).toHaveBeenCalledTimes(1);
    const portal = await userModel.findOne({ nombre: 'Usuario de portal' }).lean();
    await expect(
      service.actualizarDeuda(deudaId, { facturadorId: portal!._id.toString() }, contadora),
    ).rejects.toBeInstanceOf(BadRequestException);

    const sinVencer = await service.actualizarDeuda(deudaId, { fechaVencimiento: null }, contadora);
    expect(sinVencer.deudas[0].fechaVencimiento).toBeNull();
  });
});
