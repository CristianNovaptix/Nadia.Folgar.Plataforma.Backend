import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Cliente, ClienteDocument } from '../clientes/schemas/cliente.schema';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  ArcaSincronizacion,
  ArcaSincronizacionDocument,
} from '../arca-sync/schemas/arca-sincronizacion.schema';
import type {
  ArcaComprobante,
  ArcaDeuda,
  ArcaVencimiento,
  ArcaVep,
} from '../arca-sync/ports/arca-portal.port';
import {
  EstadoFactura,
  Factura,
  FacturaDocument,
} from '../facturacion-electronica/schemas/factura.schema';
import {
  TareaPresentacion,
  TareaPresentacionDocument,
} from '../iva-tareas/schemas/tarea-presentacion.schema';
import { Vencimiento, VencimientoDocument } from '../notificaciones/schemas/vencimiento.schema';
import { Reunion, ReunionDocument } from '../inicio/schemas/reunion.schema';
import { PanelClienteMes, PanelClienteMesDocument } from './schemas/panel-cliente-mes.schema';
import { DeudaHonorario, DeudaHonorarioDocument } from '../finanzas/schemas/deuda-honorario.schema';
import { nombrePeriodo, redondear } from '../finanzas/periodos';

export interface HonorarioResumen {
  _id: string;
  concepto: string;
  monto: number;
  fechaEmision?: Date;
  numeroComprobante?: string;
  pagada: boolean;
}

/**
 * Lo que ve el rol cliente en su Inicio. Solo datos reales: lo último
 * sincronizado de ARCA con su clave fiscal (sin credenciales) y las facturas
 * de honorarios que el estudio le emitió. Cada bloque de ARCA es `null`
 * mientras no se haya podido leer — distinto de `[]` ("se leyó y no hay nada").
 */
export interface ResumenCliente {
  cliente: { nombre: string; cuit: string };
  arca: {
    estado: string;
    ultimaSincronizacion?: Date;
    comprobantes: ArcaComprobante[] | null;
    vencimientos: ArcaVencimiento[] | null;
    veps: ArcaVep[] | null;
    deudas: ArcaDeuda[] | null;
  };
  honorarios: HonorarioResumen[];
  /** Lo que el estudio cargó a mano, por mes ("Panel del cliente" de su carpeta). */
  panel: PanelClienteMes[];
  /** Tareas del tablero de este cliente (presentaciones con su vencimiento). */
  tareas: unknown[];
  /** Vencimientos cargados por el estudio para este cliente. */
  vencimientos: unknown[];
  /** Reuniones/eventos del calendario asociados a este cliente, las cree quien las cree. */
  reuniones: unknown[];
}

@Injectable()
export class ResumenClienteService {
  constructor(
    @InjectModel(Cliente.name) private readonly clienteModel: Model<ClienteDocument>,
    @InjectModel(ArcaSincronizacion.name)
    private readonly sincronizacionModel: Model<ArcaSincronizacionDocument>,
    @InjectModel(Factura.name) private readonly facturaModel: Model<FacturaDocument>,
    @InjectModel(PanelClienteMes.name)
    private readonly panelModel: Model<PanelClienteMesDocument>,
    @InjectModel(TareaPresentacion.name)
    private readonly tareaModel: Model<TareaPresentacionDocument>,
    @InjectModel(Vencimiento.name) private readonly vencimientoModel: Model<VencimientoDocument>,
    @InjectModel(Reunion.name) private readonly reunionModel: Model<ReunionDocument>,
    @InjectModel(DeudaHonorario.name)
    private readonly deudaHonorarioModel: Model<DeudaHonorarioDocument>,
  ) {}

  /**
   * Siempre el cliente del token: no recibe ningún id por parámetro, así un
   * usuario cliente nunca puede pedir los datos de otro.
   */
  async resumen(user: AuthenticatedUser): Promise<ResumenCliente> {
    if (!user.roles.includes('cliente') || !user.clienteId) {
      throw new ForbiddenException('Solo disponible para usuarios del portal de clientes');
    }
    const estudioId = new Types.ObjectId(user.estudioId);
    const clienteId = new Types.ObjectId(user.clienteId);

    const [cliente, sync, facturas, panel, tareas, vencimientos, reuniones, deudasHonorarios] =
      await Promise.all([
        this.clienteModel
          .findOne({ _id: clienteId, estudioId }, { nombre: 1, cuit: 1, credencialesArca: 1 })
          .lean()
          .exec(),
        this.sincronizacionModel.findOne({ clienteId, estudioId }).lean().exec(),
        this.facturaModel
          .find({ clienteId, estudioId, estado: EstadoFactura.EMITIDA })
          .sort({ fechaEmision: -1, _id: -1 })
          .lean()
          .exec(),
        this.panelModel.find({ clienteId, estudioId }).sort({ periodo: 1 }).lean().exec(),
        this.tareaModel
          .find(
            { clienteId, estudioId, enPapelera: { $ne: true } },
            'titulo jurisdiccion periodo fechaDesde fechaHasta estado prioridad clienteId createdAt',
          )
          .populate('clienteId', 'nombre cuit')
          .lean()
          .exec(),
        this.vencimientoModel.find({ clienteId, estudioId }).sort({ fecha: 1 }).lean().exec(),
        this.reunionModel
          .find({ clienteId, estudioId, enPapelera: { $ne: true } }, '-googleEventos')
          .sort({ fecha: 1 })
          .populate('clienteId', 'nombre')
          .populate('miembros', 'nombre')
          .lean()
          .exec(),
        this.deudaHonorarioModel
          .find({ clienteId, estudioId }, 'periodo monto pagado')
          .sort({ periodo: -1 })
          .lean()
          .exec(),
      ]);
    if (!cliente) throw new ForbiddenException('Cliente no encontrado');

    // Deuda mensual de honorarios (Finanzas): lo que falta pagar de cada mes va
    // como pendiente y lo ya pagado (aunque sea una parte) como abonado.
    const honorariosMensuales: HonorarioResumen[] = deudasHonorarios.flatMap((d) => {
      const concepto = `Honorarios ${nombrePeriodo(d.periodo)}`;
      const fechaEmision = new Date(`${d.periodo}-15T12:00:00-03:00`);
      const saldo = redondear(d.monto - d.pagado);
      return [
        ...(saldo > 0
          ? [
              {
                _id: `${d._id.toString()}-saldo`,
                concepto,
                monto: saldo,
                fechaEmision,
                pagada: false,
              },
            ]
          : []),
        ...(d.pagado > 0
          ? [
              {
                _id: `${d._id.toString()}-pagado`,
                concepto,
                monto: d.pagado,
                fechaEmision,
                pagada: true,
              },
            ]
          : []),
      ];
    });

    // Mismo criterio que `ArcaSyncService.toResumen`: el CUIT propio es el usuario de ARCA.
    const cuitPropio = (cliente.credencialesArca?.usuario ?? cliente.cuit ?? '').replace(/\D/g, '');
    const datos =
      sync?.datosPorCuit?.[cuitPropio] ??
      (sync?.contribuyentes?.[0] ? sync.datosPorCuit?.[sync.contribuyentes[0].cuit] : undefined);

    return {
      cliente: { nombre: cliente.nombre, cuit: cliente.cuit },
      arca: {
        estado: sync?.estado ?? 'nunca',
        ultimaSincronizacion: sync?.ultimaSincronizacion,
        comprobantes: datos?.comprobantes ?? null,
        vencimientos: datos?.vencimientos ?? null,
        veps: datos?.veps ?? null,
        deudas: datos?.deudas ?? null,
      },
      honorarios: [
        ...honorariosMensuales,
        ...facturas.map((f) => ({
          _id: f._id.toString(),
          concepto: f.concepto,
          monto: f.monto,
          fechaEmision: f.fechaEmision,
          numeroComprobante: f.numeroComprobante,
          pagada: Boolean(f.pagada),
        })),
      ],
      panel,
      tareas,
      vencimientos,
      reuniones,
    };
  }
}
