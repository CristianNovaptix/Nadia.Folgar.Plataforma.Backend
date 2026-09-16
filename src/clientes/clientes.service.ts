import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import * as argon2 from 'argon2';
import { Cliente, ClienteDocument } from './schemas/cliente.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Role, RoleDocument } from '../roles/schemas/role.schema';
import {
  IntegracionIa,
  IntegracionIaDocument,
} from '../configuracion/schemas/integracion-ia.schema';
import { CreateClienteDto } from './dto/create-cliente.dto';
import { UpdateClienteDto } from './dto/update-cliente.dto';
import { QueryClienteDto } from './dto/query-cliente.dto';
import { PaginatedResult } from '../common/dto/pagination-query.dto';
import { MailService } from '../common/mail/mail.service';
import { generarPasswordSegura } from '../common/utils/password.util';

function normalizeCuit(cuit: string): string {
  return cuit.replace(/-/g, '');
}

interface PersonalRef {
  _id: Types.ObjectId;
  nombre: string;
  email?: string;
}

@Injectable()
export class ClientesService {
  constructor(
    @InjectModel(Cliente.name) private readonly clienteModel: Model<ClienteDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(IntegracionIa.name)
    private readonly integracionIaModel: Model<IntegracionIaDocument>,
    private readonly mailService: MailService,
  ) {}

  /**
   * Usuarios marcados como `esTitular` (dueño/a real del estudio, hoy solo
   * Nadia Folgar) — van en `responsablesEfectivos` de TODOS los clientes.
   * A propósito NO es "cualquier usuario con rol admin": el estudio tiene
   * una cuenta de admin de desarrollo ("Yami") que el usuario pidió
   * explícitamente que no aparezca acá — ver el comentario en
   * `user.schema.ts`. Es una regla calculada, no un dato grabado en el
   * cliente — así no hace falta re-migrar nada si cambia quién es titular.
   */
  private async findResponsablesAutomaticos(estudioId: Types.ObjectId): Promise<PersonalRef[]> {
    const titulares = await this.userModel
      .find({ estudioId, esTitular: true, activo: true })
      .select('nombre email')
      .exec();
    return titulares.map((titular) => ({
      _id: titular._id,
      nombre: titular.nombre,
      email: titular.email,
    }));
  }

  /**
   * Email de login del usuario de portal ya creado para cada cliente (ver
   * `crearUsuarioPortal`) — es el mismo `Cliente.email` real (pedido
   * explícito del usuario: el portal se loguea con el email real, no con
   * uno institucional armado del nombre). `null`/ausente = todavía no
   * tiene uno. Una sola query para todos los clientes de la página (`$in`),
   * no una por fila.
   */
  private async findUsuariosPortal(clienteIds: Types.ObjectId[]): Promise<Map<string, string>> {
    const usuarios = await this.userModel
      .find({ clienteId: { $in: clienteIds } })
      .select('clienteId email')
      .exec();
    const mapa = new Map<string, string>();
    for (const usuario of usuarios) {
      if (usuario.clienteId && usuario.email) {
        mapa.set(usuario.clienteId.toString(), usuario.email);
      }
    }
    return mapa;
  }

  /**
   * `responsablesEfectivos` = SOLO el/la titular (hoy Nadia Folgar) — a
   * propósito no se mezcla con `responsableIds` ("Personal a cargo", quien
   * de verdad trabaja ese cliente): son dos conceptos separados, pedido
   * explícito del usuario ("en responsable solo debe estar Nadia Folgar,
   * personal a cargo es otra cosa"). Antes esta función unía ambos arrays
   * (con dedup) — se sacó esa unión, no solo el dedup. De paso agrega
   * `usuarioPortalEmail` (ver `findUsuariosPortal`) — pedido explícito del
   * usuario: si este cliente ya tiene un usuario de portal creado, eso debe
   * quedar visible siempre, no solo una vez en el diálogo de credenciales.
   */
  private async attachResponsablesEfectivos(
    clientes: ClienteDocument[],
    estudioId: Types.ObjectId,
  ): Promise<Record<string, unknown>[]> {
    const [automaticos, usuariosPortal] = await Promise.all([
      this.findResponsablesAutomaticos(estudioId),
      this.findUsuariosPortal(clientes.map((cliente) => cliente._id)),
    ]);
    return clientes.map((cliente) => {
      const obj = cliente.toObject() as unknown as Record<string, unknown>;
      obj.responsablesEfectivos = automaticos;
      obj.usuarioPortalEmail = usuariosPortal.get(cliente._id.toString()) ?? null;
      return obj;
    });
  }

  /** `motorIaPreferido` solo puede setearse a un proveedor que el estudio ya conectó en Configuración → Integraciones. */
  private async validarMotorIaPreferido(
    dto: CreateClienteDto | UpdateClienteDto,
    estudioId: Types.ObjectId,
  ): Promise<void> {
    if (!dto.motorIaPreferido) return;

    const conectada = await this.integracionIaModel
      .exists({ estudioId, proveedor: dto.motorIaPreferido })
      .exec();
    if (!conectada) {
      throw new BadRequestException(
        `El estudio no tiene conectado "${dto.motorIaPreferido}" en Configuración → Integraciones.`,
      );
    }
  }

  async findAll(
    query: QueryClienteDto,
    estudioId: Types.ObjectId,
  ): Promise<PaginatedResult<Record<string, unknown>>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const filter: FilterQuery<ClienteDocument> = { estudioId };

    if (query.regimenFiscal) {
      filter.regimenFiscal = query.regimenFiscal;
    }

    if (query.search) {
      filter.$or = [
        { nombre: { $regex: query.search, $options: 'i' } },
        { cuit: { $regex: query.search, $options: 'i' } },
        { email: { $regex: query.search, $options: 'i' } },
      ];
    }

    const sort: Record<string, 1 | -1> = query.sortBy
      ? { [query.sortBy]: query.sortDir === 'desc' ? -1 : 1 }
      : { nombre: 1 };

    const [data, total] = await Promise.all([
      this.clienteModel
        .find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        // "Personal" (Frontend) muestra los responsables con nombre/email
        // reales, no solo el ID — ver `responsableIds` en `cliente.schema.ts`.
        .populate('responsableIds', 'nombre email')
        .exec(),
      this.clienteModel.countDocuments(filter).exec(),
    ]);

    return { data: await this.attachResponsablesEfectivos(data, estudioId), total, page, limit };
  }

  async findOne(id: string, estudioId: Types.ObjectId): Promise<Record<string, unknown>> {
    const cliente = await this.findOneDocument(id, estudioId);
    const [withResponsables] = await this.attachResponsablesEfectivos([cliente], estudioId);
    return withResponsables;
  }

  private async findOneDocument(id: string, estudioId: Types.ObjectId): Promise<ClienteDocument> {
    const cliente = await this.clienteModel
      .findOne({ _id: id, estudioId })
      .populate('responsableIds', 'nombre email')
      .exec();
    if (!cliente) {
      throw new NotFoundException('Cliente no encontrado');
    }
    return cliente;
  }

  async create(dto: CreateClienteDto, estudioId: Types.ObjectId): Promise<ClienteDocument> {
    const cuit = normalizeCuit(dto.cuit);
    const existing = await this.clienteModel.findOne({ cuit }).exec();
    if (existing) {
      throw new ConflictException('Ya existe un cliente con ese CUIT');
    }
    await this.validarMotorIaPreferido(dto, estudioId);

    return this.clienteModel.create({ ...dto, cuit, estudioId });
  }

  async update(
    id: string,
    dto: UpdateClienteDto,
    estudioId: Types.ObjectId,
  ): Promise<Record<string, unknown>> {
    const cliente = await this.findOneDocument(id, estudioId);
    await this.validarMotorIaPreferido(dto, estudioId);
    const { responsableIds, ...rest } = dto;
    Object.assign(cliente, { ...rest, cuit: dto.cuit ? normalizeCuit(dto.cuit) : cliente.cuit });
    // Se maneja aparte del spread de arriba: `undefined` (campo ausente del
    // body) = no tocar la asignación actual; `[]` = vaciarla; un array con
    // IDs = reemplazarla tal cual (el Frontend arma el array completo antes
    // de mandarlo — ver `agregarResponsableCliente`/`quitarResponsableCliente`
    // en `clientes/api.ts` del Frontend, que primero leen la asignación
    // actual del cliente para no perder a otros integrantes ya asignados).
    if (responsableIds !== undefined) {
      cliente.responsableIds = responsableIds.map(
        (responsableId) => new Types.ObjectId(responsableId),
      );
    }
    await cliente.save();
    // `responsableIds` quedó con ObjectIds sin poblar tras el `save()` (se
    // reasignó arriba con IDs crudos) — hace falta volver a poblarlo antes
    // de armar `responsablesEfectivos`, si no `attachResponsablesEfectivos`
    // ve objetos sin `nombre`/`email`.
    await cliente.populate('responsableIds', 'nombre email');
    const [withResponsables] = await this.attachResponsablesEfectivos([cliente], estudioId);
    return withResponsables;
  }

  async deactivate(id: string, estudioId: Types.ObjectId): Promise<void> {
    const cliente = await this.findOneDocument(id, estudioId);
    cliente.activo = false;
    await cliente.save();
  }

  /**
   * "Crear usuario y enviarle las credenciales por email" del alta/menú de
   * Cliente del Frontend — pedido explícito del usuario, revierte una
   * decisión anterior: el usuario de login del portal es el email REAL ya
   * cargado en el cliente (`Cliente.email`), no uno institucional
   * `@folgar.com.ar` armado a partir del nombre (eso queda exclusivo de
   * "Personal" — ver `UsersService.generarCredencialesInstitucionales`/
   * `generarCredencialesDeAcceso`). Por eso acá `Cliente.email` pasa a ser
   * obligatorio para poder crear el usuario de portal: sin un email propio
   * no hay con qué loguearse. El `User` de portal no existe todavía en este
   * punto (a diferencia de Personal, donde ya existe) — se crea con el rol
   * de sistema "cliente" (ve solo el portal, mismo gate de permisos que
   * cualquier otro usuario con ese rol) y `clienteId` apuntando a este
   * cliente.
   */
  async crearUsuarioPortal(
    id: string,
    estudioId: Types.ObjectId,
  ): Promise<{ usuario: UserDocument; password: string; emailEnviado: boolean }> {
    const cliente = await this.findOneDocument(id, estudioId);

    if (!cliente.email) {
      throw new BadRequestException(
        'Este cliente necesita un email cargado para poder crear su usuario de portal',
      );
    }

    const yaTieneUsuario = await this.userModel.findOne({ clienteId: cliente._id }).exec();
    if (yaTieneUsuario) {
      throw new ConflictException('Este cliente ya tiene un usuario de portal creado');
    }

    const emailLogin = cliente.email.toLowerCase().trim();
    const yaExisteEseLogin = await this.userModel.findOne({ email: emailLogin }).exec();
    if (yaExisteEseLogin) {
      throw new ConflictException('Ya existe un usuario con ese email');
    }

    const rolCliente = await this.roleModel.findOne({ nombre: 'cliente' }).exec();
    if (!rolCliente) {
      throw new BadRequestException('No se encontró el rol de sistema "cliente"');
    }

    const password = generarPasswordSegura();
    const usuario = await this.userModel.create({
      email: emailLogin,
      passwordHash: await argon2.hash(password),
      credencialesGeneradas: true,
      nombre: cliente.nombre,
      roleIds: [rolCliente._id],
      clienteId: cliente._id,
      estudioId,
    });

    const emailEnviado = await this.mailService.enviarCredenciales({
      to: emailLogin,
      usuario: emailLogin,
      nombre: cliente.nombre,
      password,
      esCliente: true,
    });

    return { usuario, password, emailEnviado };
  }

  /**
   * "Cambiar contraseña" del menú de Clientes — pedido explícito del
   * usuario, mismo criterio que `UsersService.regenerarPassword` de
   * "Personal": para un cliente que YA tiene un usuario de portal creado,
   * en vez de volver a ofrecer "Crear usuario". No guarda la contraseña
   * original de ninguna forma recuperable — deja una nueva como vigente (la
   * que mande el admin en `passwordManual`, o una generada si no mandó
   * ninguna), sin tocar el email de login ya asignado (el real del
   * cliente — ver `crearUsuarioPortal`). Marca `debeCambiarPassword` — es
   * temporal, tiene que cambiarla en su próximo login. Le avisa por mail a
   * `cliente.email`.
   */
  async regenerarPasswordPortal(
    id: string,
    estudioId: Types.ObjectId,
    passwordManual?: string,
  ): Promise<{ usuario: UserDocument; password: string; emailEnviado: boolean }> {
    const cliente = await this.findOneDocument(id, estudioId);
    const usuario = await this.userModel.findOne({ clienteId: cliente._id }).exec();
    if (!usuario) {
      throw new NotFoundException('Este cliente todavía no tiene un usuario de portal creado');
    }

    const password = passwordManual || generarPasswordSegura();
    usuario.passwordHash = await argon2.hash(password);
    usuario.debeCambiarPassword = true;
    await usuario.save();

    const emailEnviado = cliente.email
      ? await this.mailService.enviarCredenciales({
          to: cliente.email,
          usuario: usuario.email ?? '',
          nombre: cliente.nombre,
          password,
          esCliente: true,
        })
      : false;

    return { usuario, password, emailEnviado };
  }
}
