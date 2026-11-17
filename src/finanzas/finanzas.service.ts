import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { FilterQuery, Model, Types } from 'mongoose';
import { Cliente, ClienteDocument } from '../clientes/schemas/cliente.schema';
import { ClienteHistorialService } from '../clientes/cliente-historial.service';
import { PERMISSIONS } from '../common/constants/permissions';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  ActualizarDeudaDto,
  AnularPagoDto,
  GuardarHonorarioDto,
  RegistrarPagoDto,
} from './dto/finanzas.dto';
import {
  DIA_INICIO_PAGO_DEFECTO,
  DIA_VENCIMIENTO_DEFECTO,
  fechaDePago,
  inicioDePeriodo,
  mesesEntre,
  nombrePeriodo,
  periodoDe,
  plazoDePago,
  redondear,
  sumarMeses,
} from './periodos';
import { AbonoCambio, AbonoCambioDocument } from './schemas/abono-cambio.schema';
import {
  DeudaHonorario,
  DeudaHonorarioDocument,
  EstadoDeuda,
  MedioPago,
} from './schemas/deuda-honorario.schema';
import {
  AdelantoHonorario,
  HonorarioConfig,
  HonorarioConfigDocument,
} from './schemas/honorario-config.schema';

/** Tipos de evento que Finanzas deja en el historial del cliente. */
export const EVENTO_FINANZAS = {
  ABONO: 'honorario_abono',
  CONFIG: 'honorario_config',
  DEUDA: 'honorario_deuda',
  PAGO: 'honorario_pago',
  PAGO_ANULADO: 'honorario_pago_anulado',
} as const;

const MEDIO_LABEL: Record<MedioPago, string> = {
  [MedioPago.TRANSFERENCIA]: 'transferencia',
  [MedioPago.EFECTIVO]: 'efectivo',
  [MedioPago.CHEQUE]: 'cheque',
  [MedioPago.MERCADO_PAGO]: 'Mercado Pago',
  [MedioPago.OTRO]: 'otro medio',
};

function pesos(monto: number): string {
  return monto.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
}

export function estadoDe(monto: number, pagado: number): EstadoDeuda {
  if (pagado <= 0) return EstadoDeuda.PENDIENTE;
  return pagado >= monto ? EstadoDeuda.PAGADA : EstadoDeuda.PARCIAL;
}

/** Vencida = todavía debe algo y ya pasó su fecha de vencimiento. */
export function estaVencida(
  deuda: { monto: number; pagado: number; fechaVencimiento?: Date | null },
  ahora: Date = new Date(),
): boolean {
  return (
    deuda.monto - deuda.pagado > 0 &&
    !!deuda.fechaVencimiento &&
    new Date(deuda.fechaVencimiento).getTime() < ahora.getTime()
  );
}

function fechaCorta(fecha: Date): string {
  return fecha.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
}

interface CambioAbono {
  _id: Types.ObjectId;
  fecha: Date;
  montoAnterior?: number | null;
  montoNuevo: number;
  usuarioNombre?: string;
}

/**
 * Historial de abonos listo para mostrar, del más nuevo al más viejo. Por
 * cada cambio: la diferencia con el monto anterior, cuántos meses se había
 * mantenido ese monto anterior y cuántos meses lleva (o duró) el nuevo.
 */
export function armarHistorialAbonos(cambios: CambioAbono[], hoy: Date = new Date()) {
  const asc = [...cambios].sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
  return asc
    .map((cambio, i) => {
      const previo = asc[i - 1];
      const siguiente = asc[i + 1];
      const tieneAnterior = cambio.montoAnterior !== undefined && cambio.montoAnterior !== null;
      return {
        _id: cambio._id.toString(),
        fecha: cambio.fecha,
        montoAnterior: tieneAnterior ? cambio.montoAnterior! : null,
        montoNuevo: cambio.montoNuevo,
        diferencia: tieneAnterior ? redondear(cambio.montoNuevo - cambio.montoAnterior!) : null,
        mesesMontoAnterior: previo
          ? mesesEntre(periodoDe(previo.fecha), periodoDe(cambio.fecha))
          : null,
        mesesVigente: mesesEntre(periodoDe(cambio.fecha), periodoDe(siguiente?.fecha ?? hoy)),
        vigente: !siguiente,
        usuarioNombre: cambio.usuarioNombre ?? null,
      };
    })
    .reverse();
}

type Ref = { _id: Types.ObjectId; nombre: string };
type ClienteBasico = { _id: Types.ObjectId; nombre: string; cuit: string; activo?: boolean };
type DeudaLean = DeudaHonorario & { _id: Types.ObjectId; createdAt?: Date };
type ConfigLean = HonorarioConfig & { _id: Types.ObjectId };

/** Lo que el cliente tiene a favor: pagos adelantados que todavía no se usaron. */
export function saldoAFavorDe(config?: { adelantos?: AdelantoHonorario[] } | null): number {
  return redondear(
    (config?.adelantos ?? [])
      .filter((a) => !a.anulado)
      .reduce((s, a) => s + (a.disponible ?? 0), 0),
  );
}

function refDe(valor: unknown): { _id: string; nombre: string } | null {
  if (valor && typeof valor === 'object' && 'nombre' in valor) {
    const ref = valor as Ref;
    return { _id: ref._id.toString(), nombre: ref.nombre };
  }
  return null;
}

@Injectable()
export class FinanzasService {
  private readonly logger = new Logger(FinanzasService.name);

  constructor(
    @InjectModel(HonorarioConfig.name)
    private readonly configModel: Model<HonorarioConfigDocument>,
    @InjectModel(AbonoCambio.name) private readonly abonoModel: Model<AbonoCambioDocument>,
    @InjectModel(DeudaHonorario.name) private readonly deudaModel: Model<DeudaHonorarioDocument>,
    @InjectModel(Cliente.name) private readonly clienteModel: Model<ClienteDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly historial: ClienteHistorialService,
  ) {}

  // ── Quién ve qué ──────────────────────────────────────────────────────

  /**
   * `todo` = ve los honorarios de todos los clientes (Finanzas completo).
   * `propios` = solo los de los clientes que tiene a cargo (colaborador).
   */
  private alcance(user: AuthenticatedUser): 'todo' | 'propios' {
    const tiene = (permiso: string) => (user.permissions as string[]).includes(permiso);
    if (
      user.roles.includes('admin') ||
      tiene(PERMISSIONS.FINANZAS_READ) ||
      tiene(PERMISSIONS.FINANZAS_WRITE)
    ) {
      return 'todo';
    }
    if (tiene(PERMISSIONS.FINANZAS_COBROS)) return 'propios';
    throw new ForbiddenException('No tenés permisos para ver honorarios');
  }

  private filtroClientes(user: AuthenticatedUser): FilterQuery<ClienteDocument> {
    const base: FilterQuery<ClienteDocument> = {
      estudioId: new Types.ObjectId(user.estudioId),
      enPapelera: { $ne: true },
    };
    if (this.alcance(user) === 'todo') return base;
    const yo = new Types.ObjectId(user.userId);
    return { ...base, $or: [{ responsableIds: yo }, { responsableTitularId: yo }] };
  }

  private async clienteAccesible(
    clienteId: string | Types.ObjectId,
    user: AuthenticatedUser,
  ): Promise<ClienteBasico> {
    if (!Types.ObjectId.isValid(clienteId)) throw new NotFoundException('Cliente no encontrado');
    const cliente = await this.clienteModel
      .findOne({ ...this.filtroClientes(user), _id: new Types.ObjectId(clienteId) })
      .select('nombre cuit activo')
      .lean<ClienteBasico>()
      .exec();
    if (!cliente) throw new NotFoundException('Cliente no encontrado');
    return cliente;
  }

  private async deudaAccesible(
    deudaId: string,
    user: AuthenticatedUser,
  ): Promise<{ deuda: DeudaLean; cliente: ClienteBasico }> {
    if (!Types.ObjectId.isValid(deudaId)) throw new NotFoundException('Deuda no encontrada');
    const deuda = await this.deudaModel
      .findOne({ _id: deudaId, estudioId: new Types.ObjectId(user.estudioId) })
      .lean<DeudaLean>()
      .exec();
    if (!deuda) throw new NotFoundException('Deuda no encontrada');
    const cliente = await this.clienteAccesible(deuda.clienteId, user);
    return { deuda, cliente };
  }

  private async nombreUsuario(userId: string): Promise<string | undefined> {
    const usuario = await this.userModel
      .findById(userId)
      .select('nombre')
      .lean<{ nombre?: string }>()
      .exec();
    return usuario?.nombre;
  }

  // ── Consultas ─────────────────────────────────────────────────────────

  /** Integrantes de Personal que pueden figurar como "quién factura". */
  async facturadores(user: AuthenticatedUser) {
    this.alcance(user);
    const usuarios = await this.userModel
      .find({ clienteId: { $exists: false }, activo: { $ne: false } }, 'nombre')
      .sort({ nombre: 1 })
      .lean<Ref[]>()
      .exec();
    return usuarios.map((u) => ({ _id: u._id.toString(), nombre: u.nombre }));
  }

  /** Un renglón por cliente: su abono, quién le factura y cuánto debe. */
  async listar(user: AuthenticatedUser) {
    const estudioId = new Types.ObjectId(user.estudioId);
    const periodo = periodoDe(new Date());
    const clientes = await this.clienteModel
      .find(this.filtroClientes(user))
      .select('nombre cuit activo')
      .sort({ nombre: 1 })
      .lean<ClienteBasico[]>()
      .exec();
    const ids = clientes.map((c) => c._id);

    const [configs, deudas] = await Promise.all([
      this.configModel
        .find({ estudioId, clienteId: { $in: ids } })
        .populate('facturadorId', 'nombre')
        .lean<HonorarioConfig[]>()
        .exec(),
      this.deudaModel
        .find({
          estudioId,
          clienteId: { $in: ids },
          $or: [{ estado: { $ne: EstadoDeuda.PAGADA } }, { periodo }],
        })
        .select('clienteId periodo monto pagado estado fechaVencimiento')
        .lean<DeudaLean[]>()
        .exec(),
    ]);

    const configPorCliente = new Map(configs.map((c) => [c.clienteId.toString(), c]));
    const deudasPorCliente = new Map<string, DeudaLean[]>();
    for (const deuda of deudas) {
      const clave = deuda.clienteId.toString();
      deudasPorCliente.set(clave, [...(deudasPorCliente.get(clave) ?? []), deuda]);
    }

    return {
      periodo,
      clientes: clientes.map((cliente) => {
        const clave = cliente._id.toString();
        const config = configPorCliente.get(clave);
        const propias = deudasPorCliente.get(clave) ?? [];
        const impagas = propias.filter((d) => d.estado !== EstadoDeuda.PAGADA);
        const actual = propias.find((d) => d.periodo === periodo);
        return {
          cliente: {
            _id: clave,
            nombre: cliente.nombre,
            cuit: cliente.cuit,
            activo: cliente.activo !== false,
          },
          abono: config?.abono ?? 0,
          facturador: refDe(config?.facturadorId),
          diaEmision: config?.diaEmision ?? null,
          diaInicioPago: config?.diaInicioPago ?? DIA_INICIO_PAGO_DEFECTO,
          diaVencimiento: config?.diaVencimiento ?? DIA_VENCIMIENTO_DEFECTO,
          /** Pagos adelantados que todavía no se descontaron de ninguna deuda. */
          saldoAFavor: saldoAFavorDe(config),
          saldoPendiente: redondear(impagas.reduce((s, d) => s + (d.monto - d.pagado), 0)),
          /** Parte de lo que debe que ya pasó su vencimiento. */
          saldoVencido: redondear(
            impagas.filter((d) => estaVencida(d)).reduce((s, d) => s + (d.monto - d.pagado), 0),
          ),
          periodosAdeudados: impagas.length,
          deudaActual: actual
            ? {
                _id: actual._id.toString(),
                periodo: actual.periodo,
                monto: actual.monto,
                pagado: actual.pagado,
                estado: actual.estado,
                fechaVencimiento: actual.fechaVencimiento ?? null,
                vencida: estaVencida(actual),
              }
            : null,
        };
      }),
    };
  }

  /** Todo lo de honorarios de un cliente: abono, historial de abonos, deudas y pagos. */
  async detalle(clienteId: string, user: AuthenticatedUser) {
    const cliente = await this.clienteAccesible(clienteId, user);
    const estudioId = new Types.ObjectId(user.estudioId);
    const filtro = { estudioId, clienteId: cliente._id };

    const [config, cambios, deudas] = await Promise.all([
      this.configModel
        .findOne(filtro)
        .populate('facturadorId', 'nombre')
        .lean<HonorarioConfig>()
        .exec(),
      this.abonoModel.find(filtro).lean<CambioAbono[]>().exec(),
      this.deudaModel
        .find(filtro)
        .sort({ periodo: -1 })
        .populate('facturadorId', 'nombre')
        .lean<DeudaLean[]>()
        .exec(),
    ]);

    return {
      periodoActual: periodoDe(new Date()),
      cliente: {
        _id: cliente._id.toString(),
        nombre: cliente.nombre,
        cuit: cliente.cuit,
        activo: cliente.activo !== false,
      },
      abono: config?.abono ?? 0,
      facturador: refDe(config?.facturadorId),
      diaEmision: config?.diaEmision ?? null,
      diaInicioPago: config?.diaInicioPago ?? DIA_INICIO_PAGO_DEFECTO,
      diaVencimiento: config?.diaVencimiento ?? DIA_VENCIMIENTO_DEFECTO,
      saldoVencido: redondear(
        deudas.filter((d) => estaVencida(d)).reduce((s, d) => s + (d.monto - d.pagado), 0),
      ),
      historialAbonos: armarHistorialAbonos(cambios),
      saldoPendiente: redondear(deudas.reduce((s, d) => s + (d.monto - d.pagado), 0)),
      saldoAFavor: saldoAFavorDe(config),
      adelantos: [...(config?.adelantos ?? [])]
        .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
        .map((a) => ({
          _id: a._id.toString(),
          monto: a.monto,
          disponible: a.anulado ? 0 : a.disponible,
          fecha: a.fecha,
          /** Mes para el que se pagó por adelantado; `null` = el próximo que se genere. */
          periodo: a.periodo ?? null,
          medio: a.medio,
          nota: a.nota ?? null,
          registradoPorNombre: a.registradoPorNombre ?? null,
          anulado: Boolean(a.anulado),
          montoAnulado: a.montoAnulado ?? null,
          anuladoPorNombre: a.anuladoPorNombre ?? null,
          anuladoEn: a.anuladoEn ?? null,
          motivoAnulacion: a.motivoAnulacion ?? null,
        })),
      deudas: deudas.map((d) => ({
        _id: d._id.toString(),
        periodo: d.periodo,
        monto: d.monto,
        pagado: d.pagado,
        saldo: redondear(d.monto - d.pagado),
        estado: d.estado,
        origen: d.origen,
        fechaCompletada: d.fechaCompletada ?? null,
        generadaEn: d.createdAt ?? null,
        facturador: refDe(d.facturadorId),
        diaEmision: d.diaEmision ?? null,
        fechaInicioPago: d.fechaInicioPago ?? null,
        fechaVencimiento: d.fechaVencimiento ?? null,
        vencida: estaVencida(d),
        pagos: [...(d.pagos ?? [])]
          .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
          .map((p) => ({
            _id: p._id.toString(),
            monto: p.monto,
            fecha: p.fecha,
            medio: p.medio,
            nota: p.nota ?? null,
            registradoPorNombre: p.registradoPorNombre ?? null,
            registradoEn: p.registradoEn,
            anulado: Boolean(p.anulado),
            anuladoPorNombre: p.anuladoPorNombre ?? null,
            anuladoEn: p.anuladoEn ?? null,
            motivoAnulacion: p.motivoAnulacion ?? null,
          })),
      })),
    };
  }

  // ── Abono, quién factura y día de emisión ─────────────────────────────

  async guardar(clienteId: string, dto: GuardarHonorarioDto, user: AuthenticatedUser) {
    const cliente = await this.clienteAccesible(clienteId, user);
    const estudioId = new Types.ObjectId(user.estudioId);
    const filtro = { estudioId, clienteId: cliente._id };
    const abono = redondear(dto.abono);

    let facturador: Ref | null = null;
    if (dto.facturadorId) {
      facturador = await this.userModel
        .findOne({ _id: dto.facturadorId, clienteId: { $exists: false } })
        .select('nombre')
        .lean<Ref>()
        .exec();
      if (!facturador) {
        throw new BadRequestException('Quien factura tiene que ser un integrante de Personal');
      }
    }

    const actual = await this.configModel.findOne(filtro).lean<HonorarioConfig>().exec();
    const abonoAnterior = actual && actual.abono > 0 ? actual.abono : undefined;
    const ahora = new Date();

    const set: Record<string, unknown> = { abono };
    const unset: Record<string, 1> = {};
    if (abono > 0 && abonoAnterior === undefined) set.abonoDesde = ahora;
    if (abono === 0) unset.abonoDesde = 1;
    if (dto.facturadorId !== undefined) {
      if (facturador) set.facturadorId = facturador._id;
      else unset.facturadorId = 1;
    }
    if (dto.diaEmision !== undefined) {
      if (dto.diaEmision) set.diaEmision = dto.diaEmision;
      else unset.diaEmision = 1;
    }
    if (dto.diaInicioPago !== undefined) {
      if (dto.diaInicioPago) set.diaInicioPago = dto.diaInicioPago;
      else unset.diaInicioPago = 1;
    }
    if (dto.diaVencimiento !== undefined) {
      if (dto.diaVencimiento) set.diaVencimiento = dto.diaVencimiento;
      else unset.diaVencimiento = 1;
    }

    await this.configModel
      .findOneAndUpdate(
        filtro,
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { upsert: true, new: true },
      )
      .exec();

    const cambioAbono = (abonoAnterior ?? 0) !== abono;
    if (cambioAbono) {
      await this.abonoModel.create({
        ...filtro,
        montoAnterior: abonoAnterior,
        montoNuevo: abono,
        fecha: ahora,
        usuarioId: new Types.ObjectId(user.userId),
        usuarioNombre: await this.nombreUsuario(user.userId),
      });
      await this.historial.registrar(
        cliente._id,
        estudioId,
        {
          tipo: EVENTO_FINANZAS.ABONO,
          descripcion:
            abonoAnterior === undefined
              ? `Se cargó el abono mensual de honorarios: ${pesos(abono)}`
              : `Se cambió el abono mensual de honorarios de ${pesos(abonoAnterior)} a ${pesos(abono)}`,
        },
        user.userId,
      );
    }

    const otros: string[] = [];
    if (
      dto.facturadorId !== undefined &&
      (actual?.facturadorId?.toString() ?? null) !== (facturador?._id.toString() ?? null)
    ) {
      otros.push(facturador ? `factura ${facturador.nombre}` : 'sin nadie que facture');
    }
    if (dto.diaEmision !== undefined && (actual?.diaEmision ?? null) !== (dto.diaEmision ?? null)) {
      otros.push(
        dto.diaEmision ? `la factura se emite el día ${dto.diaEmision}` : 'sin día de emisión',
      );
    }
    // El plazo de pago: sin cargar vale el de por defecto (del 1 al 10).
    const desdeAntes = actual?.diaInicioPago ?? DIA_INICIO_PAGO_DEFECTO;
    const hastaAntes = actual?.diaVencimiento ?? DIA_VENCIMIENTO_DEFECTO;
    const desdeAhora =
      dto.diaInicioPago === undefined ? desdeAntes : (dto.diaInicioPago ?? DIA_INICIO_PAGO_DEFECTO);
    const hastaAhora =
      dto.diaVencimiento === undefined
        ? hastaAntes
        : (dto.diaVencimiento ?? DIA_VENCIMIENTO_DEFECTO);
    if (desdeAntes !== desdeAhora || hastaAntes !== hastaAhora) {
      otros.push(`paga del día ${desdeAhora} al día ${hastaAhora}`);
    }
    if (otros.length > 0) {
      await this.historial.registrar(
        cliente._id,
        estudioId,
        { tipo: EVENTO_FINANZAS.CONFIG, descripcion: `Honorarios: ${otros.join(' y ')}` },
        user.userId,
      );
    }

    return this.detalle(cliente._id.toString(), user);
  }

  // ── Deuda mensual ─────────────────────────────────────────────────────

  /**
   * Crea la deuda del mes para cada cliente activo con abono que todavía no
   * la tenga. Nunca duplica: hay una sola deuda por cliente y mes.
   *
   * `soloConAbonoPrevio` (lo usa la generación automática): solo clientes
   * cuyo abono ya estaba cargado antes de empezar el mes.
   */
  async generarDeudas(
    periodo: string,
    opciones: {
      origen: 'automatica' | 'manual';
      estudioId?: Types.ObjectId;
      clienteId?: Types.ObjectId;
      soloConAbonoPrevio?: boolean;
      usuarioId?: string;
    },
  ): Promise<{ creadas: number; yaExistian: number }> {
    const filtroConfig: FilterQuery<HonorarioConfigDocument> = { abono: { $gt: 0 } };
    if (opciones.estudioId) filtroConfig.estudioId = opciones.estudioId;
    if (opciones.clienteId) filtroConfig.clienteId = opciones.clienteId;
    if (opciones.soloConAbonoPrevio) filtroConfig.abonoDesde = { $lt: inicioDePeriodo(periodo) };

    const configs = await this.configModel.find(filtroConfig).lean<ConfigLean[]>().exec();
    if (configs.length === 0) return { creadas: 0, yaExistian: 0 };

    const clienteIds = configs.map((c) => c.clienteId);
    const [activos, existentes] = await Promise.all([
      this.clienteModel
        .find({ _id: { $in: clienteIds }, activo: { $ne: false }, enPapelera: { $ne: true } })
        .select('_id')
        .lean<{ _id: Types.ObjectId }[]>()
        .exec(),
      this.deudaModel
        .find({ periodo, clienteId: { $in: clienteIds } })
        .select('clienteId')
        .lean<{ clienteId: Types.ObjectId }[]>()
        .exec(),
    ]);
    const esActivo = new Set(activos.map((c) => c._id.toString()));
    const yaTiene = new Set(existentes.map((d) => d.clienteId.toString()));

    // Plazo de pago del cliente (por defecto del 1 al 10), siempre el del mes de la
    // deuda: la de noviembre se paga en noviembre aunque se genere con el mes avanzado
    // (en ese caso puede nacer ya vencida; pedido explícito del usuario).
    const plazo = (config: HonorarioConfig): { inicio: Date; fin: Date } =>
      plazoDePago(
        periodo,
        config.diaInicioPago ?? DIA_INICIO_PAGO_DEFECTO,
        config.diaVencimiento ?? DIA_VENCIMIENTO_DEFECTO,
      );

    let creadas = 0;
    let yaExistian = 0;
    for (const config of configs) {
      const clave = config.clienteId.toString();
      if (!esActivo.has(clave)) continue;
      if (yaTiene.has(clave)) {
        yaExistian += 1;
        continue;
      }
      let nueva: DeudaLean;
      try {
        const creada = await this.deudaModel.create({
          clienteId: config.clienteId,
          estudioId: config.estudioId,
          periodo,
          monto: config.abono,
          pagado: 0,
          estado: EstadoDeuda.PENDIENTE,
          pagos: [],
          facturadorId: config.facturadorId,
          diaEmision: config.diaEmision,
          fechaInicioPago: plazo(config).inicio,
          fechaVencimiento: plazo(config).fin,
          origen: opciones.origen,
        });
        nueva = creada.toObject() as DeudaLean;
      } catch (err) {
        // Otra corrida la creó al mismo tiempo: el índice único la frenó, no es un error.
        if ((err as { code?: number }).code === 11000) {
          yaExistian += 1;
          continue;
        }
        throw err;
      }
      creadas += 1;
      await this.historial.registrar(
        config.clienteId,
        config.estudioId,
        {
          tipo: EVENTO_FINANZAS.DEUDA,
          descripcion: `Se generó la deuda de honorarios de ${nombrePeriodo(periodo)}: ${pesos(config.abono)}`,
        },
        opciones.usuarioId,
      );
      // Si pagó por adelantado, se descuenta sola de esta deuda.
      await this.aplicarAdelantos(config, nueva);
    }
    return { creadas, yaExistian };
  }

  /** Descuenta de una deuda lo que el cliente tenga a favor, del adelanto más viejo al más nuevo. */
  private async aplicarAdelantos(config: ConfigLean, deuda: DeudaLean): Promise<void> {
    const adelantos = [...(config.adelantos ?? [])]
      // Lo pagado para un mes puntual no se gasta en meses anteriores a ese.
      .filter(
        (a) => !a.anulado && a.disponible > 0 && (!a.periodo || a.periodo <= deuda.periodo),
      )
      .sort((a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime());
    let pagado = deuda.pagado;
    for (const adelanto of adelantos) {
      const saldo = redondear(deuda.monto - pagado);
      if (saldo <= 0) break;
      const parte = redondear(Math.min(adelanto.disponible, saldo));
      // El filtro por `disponible` evita usar dos veces la misma plata.
      const usado = await this.configModel
        .updateOne(
          {
            _id: config._id,
            adelantos: {
              $elemMatch: { _id: adelanto._id, disponible: adelanto.disponible, anulado: { $ne: true } },
            },
          },
          { $set: { 'adelantos.$.disponible': redondear(adelanto.disponible - parte) } },
        )
        .exec();
      if (usado.modifiedCount === 0) continue;
      try {
        pagado = await this.imputar(
          { ...deuda, pagado },
          parte,
          {
            fecha: new Date(adelanto.fecha),
            medio: (adelanto.medio as MedioPago) ?? MedioPago.TRANSFERENCIA,
            nota:
              `Pago adelantado del ${fechaCorta(new Date(adelanto.fecha))}` +
              (adelanto.nota ? ` — ${adelanto.nota}` : ''),
          },
          { id: adelanto.registradoPor, nombre: adelanto.registradoPorNombre },
        );
      } catch (err) {
        // No se pudo descontar: la plata vuelve a quedar a favor, no se pierde.
        await this.configModel
          .updateOne(
            { _id: config._id, 'adelantos._id': adelanto._id },
            { $inc: { 'adelantos.$.disponible': parte } },
          )
          .exec();
        this.logger.error(`No se pudo aplicar un pago adelantado: ${(err as Error).message}`);
        break;
      }
    }
  }

  /** Botón "Generar deuda": de un cliente puntual o de todos los que falten. */
  async generarDeudasManual(
    periodo: string,
    clienteId: string | undefined,
    user: AuthenticatedUser,
  ) {
    if (periodo > periodoDe(new Date())) {
      throw new BadRequestException('No se puede generar la deuda de un mes que todavía no empezó');
    }
    const estudioId = new Types.ObjectId(user.estudioId);
    let cliente: ClienteBasico | undefined;
    if (clienteId) {
      cliente = await this.clienteAccesible(clienteId, user);
      if (cliente.activo === false) {
        throw new BadRequestException('El cliente está inactivo: no se le genera deuda');
      }
      const config = await this.configModel
        .findOne({ estudioId, clienteId: cliente._id })
        .lean<HonorarioConfig>()
        .exec();
      if (!config || config.abono <= 0) {
        throw new BadRequestException('Primero cargá el abono mensual del cliente');
      }
    }
    const resultado = await this.generarDeudas(periodo, {
      origen: 'manual',
      estudioId,
      clienteId: cliente?._id,
      usuarioId: user.userId,
    });
    if (cliente && resultado.creadas === 0) {
      throw new BadRequestException(
        `El cliente ya tiene generada la deuda de ${nombrePeriodo(periodo)}`,
      );
    }
    return resultado;
  }

  /**
   * Todos los días a las 00:10 (hora de Argentina). El día 1 genera la deuda
   * del mes; el resto de los días solo recupera lo que haya faltado (por
   * ejemplo, si el servidor estuvo caído el día 1).
   */
  @Cron('10 0 * * *', { timeZone: 'America/Argentina/Buenos_Aires' })
  async generarDeudasCron(): Promise<void> {
    try {
      const periodo = periodoDe(new Date());
      const resultado = await this.generarDeudas(periodo, {
        origen: 'automatica',
        soloConAbonoPrevio: true,
      });
      this.logger.log(
        `Deudas de honorarios ${periodo}: creadas=${resultado.creadas} yaExistian=${resultado.yaExistian}`,
      );
    } catch (err) {
      this.logger.error(`No se pudieron generar las deudas del mes: ${(err as Error).message}`);
    }
  }

  /**
   * Cambia, solo para la deuda de ese mes, quién la factura o hasta cuándo se
   * puede pagar. Lo que el cliente tiene cargado para los meses siguientes no se toca.
   */
  async actualizarDeuda(deudaId: string, dto: ActualizarDeudaDto, user: AuthenticatedUser) {
    const { deuda, cliente } = await this.deudaAccesible(deudaId, user);
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    const cambios: string[] = [];

    if (dto.facturadorId !== undefined) {
      let facturador: Ref | null = null;
      if (dto.facturadorId) {
        facturador = await this.userModel
          .findOne({ _id: dto.facturadorId, clienteId: { $exists: false } })
          .select('nombre')
          .lean<Ref>()
          .exec();
        if (!facturador) {
          throw new BadRequestException('Quien factura tiene que ser un integrante de Personal');
        }
      }
      if ((deuda.facturadorId?.toString() ?? null) !== (facturador?._id.toString() ?? null)) {
        if (facturador) set.facturadorId = facturador._id;
        else unset.facturadorId = 1;
        cambios.push(facturador ? `la factura ${facturador.nombre}` : 'sin nadie que la facture');
      }
    }

    if (dto.fechaVencimiento !== undefined) {
      const fecha = dto.fechaVencimiento
        ? new Date(`${dto.fechaVencimiento}T23:59:59-03:00`)
        : null;
      if (fecha && Number.isNaN(fecha.getTime())) {
        throw new BadRequestException('Fecha de vencimiento inválida');
      }
      const anterior = deuda.fechaVencimiento ? new Date(deuda.fechaVencimiento).getTime() : null;
      if (anterior !== (fecha?.getTime() ?? null)) {
        if (fecha) set.fechaVencimiento = fecha;
        else unset.fechaVencimiento = 1;
        cambios.push(fecha ? `vence el ${fechaCorta(fecha)}` : 'sin vencimiento');
      }
    }

    if (cambios.length > 0) {
      await this.deudaModel
        .updateOne(
          { _id: deuda._id },
          {
            ...(Object.keys(set).length ? { $set: set } : {}),
            ...(Object.keys(unset).length ? { $unset: unset } : {}),
          },
        )
        .exec();
      await this.historial.registrar(
        cliente._id,
        deuda.estudioId,
        {
          tipo: EVENTO_FINANZAS.CONFIG,
          descripcion: `Honorarios de ${nombrePeriodo(deuda.periodo)}: ${cambios.join(' y ')}`,
        },
        user.userId,
      );
    }
    return this.detalle(cliente._id.toString(), user);
  }

  // ── Pagos ─────────────────────────────────────────────────────────────

  async registrarPago(deudaId: string, dto: RegistrarPagoDto, user: AuthenticatedUser) {
    const { deuda, cliente } = await this.deudaAccesible(deudaId, user);
    const saldo = redondear(deuda.monto - deuda.pagado);
    const monto = redondear(dto.monto);
    if (saldo <= 0) throw new BadRequestException('Esta deuda ya está pagada');
    if (monto > saldo) {
      throw new BadRequestException(
        `El pago (${pesos(monto)}) supera lo que falta cobrar (${pesos(saldo)}) de ese mes. ` +
          'Para un pago adelantado usá "Registrar pago" del cliente.',
      );
    }
    const fecha = fechaDePago(dto.fecha);
    if (Number.isNaN(fecha.getTime())) throw new BadRequestException('Fecha de pago inválida');
    if (fecha.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      throw new BadRequestException('La fecha del pago no puede ser futura');
    }

    await this.imputar(
      deuda,
      monto,
      { fecha, medio: dto.medio ?? MedioPago.TRANSFERENCIA, nota: dto.nota },
      { id: new Types.ObjectId(user.userId), nombre: await this.nombreUsuario(user.userId) },
    );
    return this.detalle(cliente._id.toString(), user);
  }

  /** Guarda un pago dentro de la deuda de un mes y lo deja en el historial. Devuelve lo pagado. */
  private async imputar(
    deuda: DeudaLean,
    monto: number,
    datos: { fecha: Date; medio: MedioPago; nota?: string },
    quien: { id?: Types.ObjectId; nombre?: string },
  ): Promise<number> {
    const pagado = redondear(deuda.pagado + monto);
    const estado = estadoDe(deuda.monto, pagado);
    const ahora = new Date();

    // El filtro por `pagado` evita que dos pagos cargados a la vez se pisen.
    const actualizada = await this.deudaModel
      .findOneAndUpdate(
        { _id: deuda._id, pagado: deuda.pagado },
        {
          $push: {
            pagos: {
              _id: new Types.ObjectId(),
              monto,
              fecha: datos.fecha,
              medio: datos.medio,
              nota: datos.nota?.trim() || undefined,
              registradoPor: quien.id,
              registradoPorNombre: quien.nombre,
              registradoEn: ahora,
              anulado: false,
            },
          },
          $set: {
            pagado,
            estado,
            ...(estado === EstadoDeuda.PAGADA ? { fechaCompletada: ahora } : {}),
          },
        },
        { new: true },
      )
      .exec();
    if (!actualizada) {
      throw new ConflictException(
        'Esta deuda cambió recién. Actualizá la pantalla y probá de nuevo.',
      );
    }

    await this.historial.registrar(
      deuda.clienteId,
      deuda.estudioId,
      {
        tipo: EVENTO_FINANZAS.PAGO,
        descripcion:
          `Pago ${estado === EstadoDeuda.PAGADA ? 'total' : 'parcial'} de honorarios de ` +
          `${nombrePeriodo(deuda.periodo)}: ${pesos(monto)} por ${MEDIO_LABEL[datos.medio] ?? datos.medio}` +
          (estado === EstadoDeuda.PAGADA
            ? ' — deuda saldada'
            : ` — falta cobrar ${pesos(redondear(deuda.monto - pagado))}`),
      },
      quien.id?.toString(),
    );
    return pagado;
  }

  /**
   * Pago del cliente sin elegir un mes: cancela primero la deuda más vieja
   * (criterio contable habitual) y sigue con las siguientes. Si paga más de
   * lo que debe, lo que sobra queda a favor y se descuenta solo de los
   * próximos meses (pago adelantado).
   */
  async registrarPagoCliente(clienteId: string, dto: RegistrarPagoDto, user: AuthenticatedUser) {
    const cliente = await this.clienteAccesible(clienteId, user);
    const estudioId = new Types.ObjectId(user.estudioId);
    const monto = redondear(dto.monto);
    const fecha = fechaDePago(dto.fecha);
    if (Number.isNaN(fecha.getTime())) throw new BadRequestException('Fecha de pago inválida');
    if (fecha.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      throw new BadRequestException('La fecha del pago no puede ser futura');
    }
    const medio = dto.medio ?? MedioPago.TRANSFERENCIA;
    const quien = {
      id: new Types.ObjectId(user.userId),
      nombre: await this.nombreUsuario(user.userId),
    };

    // Con mes elegido: paga ese mes y, si sobra, los que le siguen (nunca los anteriores).
    const periodoActual = periodoDe(new Date());
    if (dto.periodo && mesesEntre(periodoActual, dto.periodo) > 24) {
      throw new BadRequestException('El mes elegido es demasiado lejano');
    }
    // Un mes futuro todavía no tiene deuda: queda a favor reservado para ese mes.
    const periodoAdelanto = dto.periodo && dto.periodo > periodoActual ? dto.periodo : undefined;

    const impagas = await this.deudaModel
      .find({
        estudioId,
        clienteId: cliente._id,
        estado: { $ne: EstadoDeuda.PAGADA },
        ...(dto.periodo ? { periodo: { $gte: dto.periodo } } : {}),
      })
      .sort({ periodo: 1 })
      .lean<DeudaLean[]>()
      .exec();
    let resto = monto;
    for (const deuda of impagas) {
      if (resto <= 0) break;
      const parte = redondear(Math.min(resto, deuda.monto - deuda.pagado));
      if (parte <= 0) continue;
      await this.imputar(deuda, parte, { fecha, medio, nota: dto.nota }, quien);
      resto = redondear(resto - parte);
    }

    if (resto > 0) {
      await this.configModel
        .updateOne(
          { estudioId, clienteId: cliente._id },
          {
            $push: {
              adelantos: {
                _id: new Types.ObjectId(),
                monto: resto,
                disponible: resto,
                fecha,
                ...(periodoAdelanto ? { periodo: periodoAdelanto } : {}),
                medio,
                nota: dto.nota?.trim() || undefined,
                registradoPor: quien.id,
                registradoPorNombre: quien.nombre,
                registradoEn: new Date(),
                anulado: false,
              },
            },
            $setOnInsert: { abono: 0 },
          },
          { upsert: true },
        )
        .exec();
      await this.historial.registrar(
        cliente._id,
        estudioId,
        {
          tipo: EVENTO_FINANZAS.PAGO,
          descripcion:
            `Pago adelantado de honorarios${periodoAdelanto ? ` de ${nombrePeriodo(periodoAdelanto)}` : ''}: ` +
            `${pesos(resto)} por ${MEDIO_LABEL[medio]} — ` +
            (periodoAdelanto
              ? `queda a favor y se descuenta desde ${nombrePeriodo(periodoAdelanto)}`
              : `queda a favor y se descuenta desde ${nombrePeriodo(sumarMeses(periodoActual, 1))}`),
        },
        user.userId,
      );
    }
    return this.detalle(cliente._id.toString(), user);
  }

  /** Anula lo que todavía no se usó de un pago adelantado. Lo ya descontado se anula en su mes. */
  async anularAdelanto(
    clienteId: string,
    adelantoId: string,
    dto: AnularPagoDto,
    user: AuthenticatedUser,
  ) {
    const cliente = await this.clienteAccesible(clienteId, user);
    const estudioId = new Types.ObjectId(user.estudioId);
    const config = await this.configModel
      .findOne({ estudioId, clienteId: cliente._id })
      .lean<ConfigLean>()
      .exec();
    const adelanto = (config?.adelantos ?? []).find((a) => a._id.toString() === adelantoId);
    if (!config || !adelanto) throw new NotFoundException('Pago adelantado no encontrado');
    if (adelanto.anulado) throw new BadRequestException('Ese pago adelantado ya estaba anulado');
    if (adelanto.disponible <= 0) {
      throw new BadRequestException(
        'Ese pago adelantado ya se descontó entero. Anulá el pago en el mes donde se aplicó.',
      );
    }
    const hecho = await this.configModel
      .updateOne(
        {
          _id: config._id,
          adelantos: { $elemMatch: { _id: adelanto._id, disponible: adelanto.disponible } },
        },
        {
          $set: {
            'adelantos.$.anulado': true,
            'adelantos.$.disponible': 0,
            'adelantos.$.montoAnulado': adelanto.disponible,
            'adelantos.$.anuladoPorNombre': await this.nombreUsuario(user.userId),
            'adelantos.$.anuladoEn': new Date(),
            'adelantos.$.motivoAnulacion': dto.motivo.trim(),
          },
        },
      )
      .exec();
    if (hecho.modifiedCount === 0) {
      throw new ConflictException('Ese pago cambió recién. Actualizá la pantalla y probá de nuevo.');
    }
    await this.historial.registrar(
      cliente._id,
      estudioId,
      {
        tipo: EVENTO_FINANZAS.PAGO_ANULADO,
        descripcion:
          `Se anuló un pago adelantado de honorarios (${pesos(adelanto.disponible)} sin usar). ` +
          `Motivo: ${dto.motivo.trim()}`,
      },
      user.userId,
    );
    return this.detalle(cliente._id.toString(), user);
  }

  async anularPago(deudaId: string, pagoId: string, dto: AnularPagoDto, user: AuthenticatedUser) {
    const { deuda, cliente } = await this.deudaAccesible(deudaId, user);
    const pago = (deuda.pagos ?? []).find((p) => p._id.toString() === pagoId);
    if (!pago) throw new NotFoundException('Pago no encontrado');
    if (pago.anulado) throw new BadRequestException('Ese pago ya estaba anulado');

    const pagado = Math.max(0, redondear(deuda.pagado - pago.monto));
    const estado = estadoDe(deuda.monto, pagado);
    const actualizada = await this.deudaModel
      .findOneAndUpdate(
        { _id: deuda._id, pagado: deuda.pagado, 'pagos._id': pago._id },
        {
          $set: {
            'pagos.$.anulado': true,
            'pagos.$.anuladoPor': new Types.ObjectId(user.userId),
            'pagos.$.anuladoPorNombre': await this.nombreUsuario(user.userId),
            'pagos.$.anuladoEn': new Date(),
            'pagos.$.motivoAnulacion': dto.motivo.trim(),
            pagado,
            estado,
          },
          $unset: { fechaCompletada: 1 },
        },
        { new: true },
      )
      .exec();
    if (!actualizada) {
      throw new ConflictException(
        'Esta deuda cambió recién. Actualizá la pantalla y probá de nuevo.',
      );
    }

    await this.historial.registrar(
      cliente._id,
      deuda.estudioId,
      {
        tipo: EVENTO_FINANZAS.PAGO_ANULADO,
        descripcion:
          `Se anuló un pago de ${pesos(pago.monto)} de honorarios de ` +
          `${nombrePeriodo(deuda.periodo)}. Motivo: ${dto.motivo.trim()}`,
      },
      user.userId,
    );

    return this.detalle(cliente._id.toString(), user);
  }

  // ── Métricas ──────────────────────────────────────────────────────────

  /** Números generales de Finanzas de todo el estudio. Solo para Finanzas completo. */
  async metricas(user: AuthenticatedUser) {
    const estudioId = new Types.ObjectId(user.estudioId);
    const periodo = periodoDe(new Date());

    const [clientes, configs, deudas] = await Promise.all([
      this.clienteModel
        .find({ estudioId, enPapelera: { $ne: true } })
        .select('nombre cuit activo')
        .lean<ClienteBasico[]>()
        .exec(),
      this.configModel
        .find({ estudioId })
        .populate('facturadorId', 'nombre')
        .lean<HonorarioConfig[]>()
        .exec(),
      this.deudaModel.find({ estudioId }).lean<DeudaLean[]>().exec(),
    ]);

    const clientePorId = new Map(clientes.map((c) => [c._id.toString(), c]));
    const activos = clientes.filter((c) => c.activo !== false);
    const esActivo = new Set(activos.map((c) => c._id.toString()));

    // Abonos: solo cuentan los de clientes activos (son los que se van a cobrar).
    const configsActivas = configs.filter(
      (c) => c.abono > 0 && esActivo.has(c.clienteId.toString()),
    );
    const abonoMensualTotal = redondear(configsActivas.reduce((s, c) => s + c.abono, 0));

    const porFacturador = new Map<
      string,
      { nombre: string; clientes: number; abonoTotal: number }
    >();
    for (const config of configsActivas) {
      const ref = refDe(config.facturadorId);
      const clave = ref?._id ?? 'sin';
      const fila = porFacturador.get(clave) ?? {
        nombre: ref?.nombre ?? 'Sin asignar',
        clientes: 0,
        abonoTotal: 0,
      };
      fila.clientes += 1;
      fila.abonoTotal = redondear(fila.abonoTotal + config.abono);
      porFacturador.set(clave, fila);
    }

    // Deudas: las de clientes en la papelera no cuentan.
    const deudasVisibles = deudas.filter((d) => clientePorId.has(d.clienteId.toString()));

    // Desde enero del año anterior hasta el mes en curso: alcanza para ver un año completo.
    const desdeEnero = 12 + Number(periodo.split('-')[1]);
    const meses = Array.from({ length: desdeEnero }, (_, i) =>
      sumarMeses(periodo, i - (desdeEnero - 1)),
    );
    const evolucion = new Map(
      meses.map((m) => [
        m,
        {
          periodo: m,
          generado: 0,
          /** Lo que entró ese mes, sea de la deuda de ese mes o de anteriores. */
          cobrado: 0,
          /** Cuánto de la deuda de ese mes ya se pagó (en cualquier momento). */
          cobradoDelPeriodo: 0,
          /** La deuda de ese mes, cliente por cliente. */
          clientes: [] as {
            clienteId: string;
            nombre: string;
            generado: number;
            cobrado: number;
          }[],
        },
      ]),
    );
    const vencidoPorCliente = new Map<string, number>();
    let deudaVencida = 0;
    const saldoPorCliente = new Map<string, { saldo: number; periodos: number }>();
    const mesPorCliente = new Map<string, { generado: number; cobrado: number }>();
    const tramos = [
      { tramo: 'Mes en curso', monto: 0 },
      { tramo: '1 mes de atraso', monto: 0 },
      { tramo: '2 meses de atraso', monto: 0 },
      { tramo: '3 meses o más', monto: 0 },
    ];
    let generadoMes = 0;
    let cobradoDelMes = 0;
    let cobradoEnElMes = 0;
    let deudaTotal = 0;
    let deudaAtrasada = 0;

    for (const deuda of deudasVisibles) {
      const fila = evolucion.get(deuda.periodo);
      if (fila) {
        fila.generado = redondear(fila.generado + deuda.monto);
        fila.cobradoDelPeriodo = redondear(fila.cobradoDelPeriodo + deuda.pagado);
        fila.clientes.push({
          clienteId: deuda.clienteId.toString(),
          nombre: clientePorId.get(deuda.clienteId.toString())?.nombre ?? 'Cliente',
          generado: deuda.monto,
          cobrado: deuda.pagado,
        });
      }
      if (deuda.periodo === periodo) {
        generadoMes += deuda.monto;
        cobradoDelMes += deuda.pagado;
        mesPorCliente.set(deuda.clienteId.toString(), {
          generado: deuda.monto,
          cobrado: deuda.pagado,
        });
      }
      for (const pago of deuda.pagos ?? []) {
        if (pago.anulado) continue;
        const mesPago = periodoDe(new Date(pago.fecha));
        const filaPago = evolucion.get(mesPago);
        if (filaPago) filaPago.cobrado = redondear(filaPago.cobrado + pago.monto);
        if (mesPago === periodo) cobradoEnElMes += pago.monto;
      }
      const saldo = redondear(deuda.monto - deuda.pagado);
      if (saldo <= 0) continue;
      deudaTotal += saldo;
      const atraso = Math.max(0, mesesEntre(deuda.periodo, periodo));
      if (atraso > 0) deudaAtrasada += saldo;
      tramos[Math.min(atraso, 3)].monto = redondear(tramos[Math.min(atraso, 3)].monto + saldo);
      const clave = deuda.clienteId.toString();
      if (estaVencida(deuda)) {
        deudaVencida += saldo;
        vencidoPorCliente.set(clave, redondear((vencidoPorCliente.get(clave) ?? 0) + saldo));
      }
      const acumulado = saldoPorCliente.get(clave) ?? { saldo: 0, periodos: 0 };
      acumulado.saldo = redondear(acumulado.saldo + saldo);
      acumulado.periodos += 1;
      saldoPorCliente.set(clave, acumulado);
    }

    // Pagos adelantados todavía sin descontar: también entraron en su mes.
    let saldoAFavorTotal = 0;
    for (const config of configs) {
      if (!clientePorId.has(config.clienteId.toString())) continue;
      for (const adelanto of config.adelantos ?? []) {
        if (adelanto.anulado || adelanto.disponible <= 0) continue;
        saldoAFavorTotal += adelanto.disponible;
        const mesPago = periodoDe(new Date(adelanto.fecha));
        const filaPago = evolucion.get(mesPago);
        if (filaPago) filaPago.cobrado = redondear(filaPago.cobrado + adelanto.disponible);
        if (mesPago === periodo) cobradoEnElMes += adelanto.disponible;
      }
    }

    // Las estadísticas arrancan en el primer mes que tiene datos: los meses de antes de
    // usar la plataforma quedarían vacíos (pedido explícito del usuario).
    const conDatos = meses.filter((m) => {
      const fila = evolucion.get(m)!;
      return fila.generado > 0 || fila.cobrado > 0;
    });
    const mesesConDatos = meses.slice(conDatos.length ? meses.indexOf(conDatos[0]) : meses.length - 1);

    const deudores = [...saldoPorCliente.entries()]
      .map(([clienteId, v]) => ({
        clienteId,
        nombre: clientePorId.get(clienteId)?.nombre ?? 'Cliente',
        saldo: v.saldo,
        periodos: v.periodos,
      }))
      .sort((a, b) => b.saldo - a.saldo);

    return {
      periodo,
      clientes: {
        activos: activos.length,
        inactivos: clientes.length - activos.length,
        conAbono: configsActivas.length,
        sinAbono: activos.length - configsActivas.length,
      },
      abonoMensualTotal,
      abonoPromedio: configsActivas.length
        ? redondear(abonoMensualTotal / configsActivas.length)
        : 0,
      mes: {
        generado: redondear(generadoMes),
        cobrado: redondear(cobradoDelMes),
        pendiente: redondear(generadoMes - cobradoDelMes),
        /** Todo lo que entró este mes, sea de la deuda de este mes o de meses anteriores. */
        ingresado: redondear(cobradoEnElMes),
      },
      /** Pagos adelantados de clientes que todavía no se descontaron de ninguna deuda. */
      saldoAFavorTotal: redondear(saldoAFavorTotal),
      deudaTotal: redondear(deudaTotal),
      deudaAtrasada: redondear(deudaAtrasada),
      /** Deuda que ya pasó su fecha de vencimiento. */
      deudaVencida: redondear(deudaVencida),
      clientesConDeuda: deudores.length,
      antiguedad: tramos,
      evolucion: mesesConDatos.map((m) => evolucion.get(m)!),
      deudores: deudores.slice(0, 8),
      /** Un renglón por cliente, para el detalle de cada índice. */
      detalleClientes: clientes
        .map((cliente) => {
          const clave = cliente._id.toString();
          const config = configs.find((c) => c.clienteId.toString() === clave);
          const mesCliente = mesPorCliente.get(clave);
          return {
            clienteId: clave,
            nombre: cliente.nombre,
            activo: cliente.activo !== false,
            abono: config?.abono ?? 0,
            facturador: refDe(config?.facturadorId)?.nombre ?? null,
            saldo: saldoPorCliente.get(clave)?.saldo ?? 0,
            saldoAFavor: saldoAFavorDe(config),
            saldoVencido: vencidoPorCliente.get(clave) ?? 0,
            periodosAdeudados: saldoPorCliente.get(clave)?.periodos ?? 0,
            mesGenerado: mesCliente?.generado ?? null,
            mesCobrado: mesCliente?.cobrado ?? 0,
          };
        })
        .sort((x, y) => x.nombre.localeCompare(y.nombre, 'es')),
      porFacturador: [...porFacturador.values()].sort((a, b) => b.abonoTotal - a.abonoTotal),
    };
  }
}
