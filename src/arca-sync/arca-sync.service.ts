import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Model, Types } from 'mongoose';
import { Cliente, ClienteDocument } from '../clientes/schemas/cliente.schema';
import { SecretCipherService } from '../common/crypto/secret-cipher.service';
import {
  ARCA_DATOS_VACIOS,
  ARCA_PORTAL_PORT,
  ArcaContribuyente,
  ArcaDatos,
  ArcaPortalPort,
} from './ports/arca-portal.port';
import {
  ArcaSincronizacion,
  ArcaSincronizacionDocument,
  ArcaSincronizacionEstado,
} from './schemas/arca-sincronizacion.schema';

export interface ClienteArcaResumen {
  clienteId: string;
  nombre: string;
  cuit: string;
  usuario: string;
  estado: ArcaSincronizacionEstado | 'nunca';
  ultimaSincronizacion?: Date;
  ultimoIntento?: Date;
  ultimoError?: string;
  /** El propio cliente primero y después las personas que representa en ARCA. */
  contribuyentes: ArcaContribuyente[];
  datosPorCuit: Record<string, ArcaDatos>;
}

/**
 * Clientes activos con usuario y contraseña de ARCA cargados. `$ne: false` y no
 * `true`: hay clientes cargados antes de que existiera el campo `activo` que no lo
 * tienen guardado, y el resto de la plataforma los trata como activos.
 */
const FILTRO_CON_ARCA = {
  activo: { $ne: false },
  'credencialesArca.usuario': { $exists: true, $ne: '' },
  'credencialesArca.passwordCifrada': { $exists: true, $ne: '' },
};

@Injectable()
export class ArcaSyncService {
  private readonly logger = new Logger(ArcaSyncService.name);
  /** Clientes con una sincronización en curso, para no abrir dos navegadores contra el mismo. */
  private readonly enCurso = new Set<string>();

  constructor(
    @InjectModel(Cliente.name) private readonly clienteModel: Model<ClienteDocument>,
    @InjectModel(ArcaSincronizacion.name)
    private readonly sincronizacionModel: Model<ArcaSincronizacionDocument>,
    @Inject(ARCA_PORTAL_PORT) private readonly arcaPortal: ArcaPortalPort,
    private readonly secretCipher: SecretCipherService,
  ) {}

  async findAll(estudioId: Types.ObjectId): Promise<ClienteArcaResumen[]> {
    const [clientes, sincronizaciones] = await Promise.all([
      this.clienteModel.find({ ...FILTRO_CON_ARCA, estudioId }).sort({ nombre: 1 }).exec(),
      this.sincronizacionModel.find({ estudioId }).exec(),
    ]);
    const porCliente = new Map(sincronizaciones.map((s) => [s.clienteId.toString(), s]));
    return clientes.map((cliente) => this.toResumen(cliente, porCliente.get(cliente._id.toString())));
  }

  async findOne(clienteId: string, estudioId: Types.ObjectId): Promise<ClienteArcaResumen> {
    const cliente = await this.findClienteConArca(clienteId, estudioId);
    const sincronizacion = await this.sincronizacionModel
      .findOne({ estudioId, clienteId: cliente._id })
      .exec();
    return this.toResumen(cliente, sincronizacion ?? undefined);
  }

  async sincronizarCliente(clienteId: string, estudioId: Types.ObjectId): Promise<ClienteArcaResumen> {
    const cliente = await this.findClienteConArca(clienteId, estudioId);
    if (this.enCurso.has(clienteId)) {
      throw new ConflictException('Este cliente ya se está sincronizando con ARCA');
    }
    const sincronizacion = await this.sincronizar(cliente);
    return this.toResumen(cliente, sincronizacion);
  }

  /** Sincronización automática diaria de todos los clientes con clave fiscal de ARCA. */
  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async sincronizarTodos(): Promise<void> {
    const clientes = await this.clienteModel.find(FILTRO_CON_ARCA).exec();
    let errores = 0;
    // De a uno a la vez: cada uno abre un navegador y no conviene saturar a ARCA.
    for (const cliente of clientes) {
      if (this.enCurso.has(cliente._id.toString())) continue;
      const resultado = await this.sincronizar(cliente);
      if (resultado.estado === ArcaSincronizacionEstado.ERROR) errores += 1;
    }
    this.logger.log(`sincronizarTodos: clientes=${clientes.length} errores=${errores}`);
  }

  private async sincronizar(cliente: ClienteDocument): Promise<ArcaSincronizacionDocument> {
    const id = cliente._id.toString();
    const filtro = { estudioId: cliente.estudioId, clienteId: cliente._id };
    this.enCurso.add(id);
    try {
      await this.sincronizacionModel
        .updateOne(
          filtro,
          { $set: { estado: ArcaSincronizacionEstado.SINCRONIZANDO, ultimoIntento: new Date() } },
          { upsert: true },
        )
        .exec();

      let update: Partial<ArcaSincronizacion>;
      try {
        const { contribuyentes, datosPorCuit } = await this.arcaPortal.sincronizar({
          cuit: cliente.credencialesArca!.usuario!.replace(/\D/g, ''),
          password: this.secretCipher.decrypt(cliente.credencialesArca!.passwordCifrada!),
        });
        update = {
          estado: ArcaSincronizacionEstado.OK,
          ultimaSincronizacion: new Date(),
          ultimoError: undefined,
          contribuyentes,
          datosPorCuit,
        };
      } catch (error) {
        const mensaje = error instanceof Error ? error.message : 'error desconocido';
        this.logger.warn(`No se pudo sincronizar con ARCA el cliente ${id}: ${mensaje}`);
        update = { estado: ArcaSincronizacionEstado.ERROR, ultimoError: mensaje };
      }

      const { ultimoError, ...set } = update;
      return (await this.sincronizacionModel
        .findOneAndUpdate(
          filtro,
          ultimoError ? { $set: { ...set, ultimoError } } : { $set: set, $unset: { ultimoError: 1 } },
          { new: true, upsert: true },
        )
        .exec())!;
    } finally {
      this.enCurso.delete(id);
    }
  }

  private async findClienteConArca(clienteId: string, estudioId: Types.ObjectId): Promise<ClienteDocument> {
    if (!Types.ObjectId.isValid(clienteId)) {
      throw new NotFoundException('Cliente no encontrado');
    }
    const cliente = await this.clienteModel
      .findOne({ ...FILTRO_CON_ARCA, _id: clienteId, estudioId })
      .exec();
    if (!cliente) {
      throw new NotFoundException('Cliente no encontrado o sin credenciales de ARCA cargadas');
    }
    return cliente;
  }

  private toResumen(cliente: ClienteDocument, sync?: ArcaSincronizacionDocument): ClienteArcaResumen {
    const cuitPropio = (cliente.credencialesArca?.usuario ?? cliente.cuit).replace(/\D/g, '');
    return {
      clienteId: cliente._id.toString(),
      nombre: cliente.nombre,
      cuit: cliente.cuit,
      usuario: cliente.credencialesArca?.usuario ?? '',
      // Una sincronización guardada antes de separar los datos por CUIT se trata como
      // "nunca": así la pantalla la vuelve a traer sola al abrir el cliente.
      estado: sync && (sync.datosPorCuit || sync.estado !== ArcaSincronizacionEstado.OK) ? sync.estado : 'nunca',
      ultimaSincronizacion: sync?.ultimaSincronizacion,
      ultimoIntento: sync?.ultimoIntento,
      ultimoError: sync?.ultimoError,
      contribuyentes: sync?.contribuyentes?.length ? sync.contribuyentes : [{ cuit: cuitPropio, nombre: cliente.nombre }],
      datosPorCuit: Object.fromEntries(
        Object.entries(sync?.datosPorCuit ?? {}).map(([cuit, datos]) => [cuit, { ...ARCA_DATOS_VACIOS, ...datos }]),
      ),
    };
  }
}
