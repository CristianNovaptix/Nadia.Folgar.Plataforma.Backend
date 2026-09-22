import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import * as argon2 from 'argon2';
import { Cliente, ClienteDocument, CredencialOrganismo } from './schemas/cliente.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Role, RoleDocument } from '../roles/schemas/role.schema';
import {
  IntegracionIa,
  IntegracionIaDocument,
} from '../configuracion/schemas/integracion-ia.schema';
import { CreateClienteDto } from './dto/create-cliente.dto';
import { UpdateClienteDto } from './dto/update-cliente.dto';
import { QueryClienteDto } from './dto/query-cliente.dto';
import { CredencialOrganismoDto } from './dto/credencial-organismo.dto';
import { PaginatedResult } from '../common/dto/pagination-query.dto';
import { MailService } from '../common/mail/mail.service';
import { generarPasswordSegura } from '../common/utils/password.util';
import { SecretCipherService } from '../common/crypto/secret-cipher.service';

/** Nombres de los tres `Prop` de `Cliente` que guardan una `CredencialOrganismo` — ver el schema. */
const ORGANISMOS = ['credencialesArca', 'credencialesArba', 'credencialesAgip'] as const;

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
    private readonly secretCipher: SecretCipherService,
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
    // `activo: true` es a propósito — un cliente con un usuario de portal viejo y
    // desactivado (ej. login institucional armado antes del cambio a email real, ver
    // el CLAUDE.md del Frontend) hoy NO puede loguearse, así que no debe contar como
    // "ya tiene acceso al portal": bug real, el filtro viejo mostraba "Con acceso al
    // portal" para 3 clientes que en los hechos no podían entrar.
    const usuarios = await this.userModel
      .find({ clienteId: { $in: clienteIds }, activo: true })
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
   *
   * También agrega `responsableTitular` (un único objeto, no un array) —
   * pedido explícito del usuario, superador de `responsablesEfectivos`: el
   * admin tiene que poder elegir a otra persona de "Personal" como
   * "Responsable" de un cliente puntual, no que sea siempre y forzosamente
   * el/la titular. Es `responsableTitularId` (ver `cliente.schema.ts`) ya
   * poblado si se eligió a mano; si todavía no se eligió nada, cae al
   * mismo default de siempre (el/la titular, `automaticos[0]`) — así el
   * Frontend siempre tiene algo para preseleccionar sin tener que calcular
   * el default por su cuenta.
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
      const elegido = obj.responsableTitularId as PersonalRef | null | undefined;
      obj.responsableTitular = elegido && 'nombre' in elegido ? elegido : (automaticos[0] ?? null);
      delete obj.responsableTitularId;
      return this.sanitizeCredenciales(obj);
    });
  }

  /**
   * Arma la `CredencialOrganismo` a persistir para un organismo (ARCA/ARBA/AGIP)
   * dado lo que llegó en el DTO y lo que ya había guardado. `dto === undefined`
   * (campo ausente del body) = no tocar nada, mismo criterio que
   * `responsableIds`. `dto.password` vacío/ausente = no reemplazar la
   * contraseña ya cifrada (solo actualiza `usuario`, si vino) — así "editar
   * el usuario de ARCA" no obliga a retipear la contraseña cada vez.
   */
  private aplicarCredencial(
    actual: CredencialOrganismo | undefined,
    dto: CredencialOrganismoDto | undefined,
  ): CredencialOrganismo | undefined {
    if (dto === undefined) return actual;
    const usuario = dto.usuario?.trim() || undefined;
    if (!dto.password) {
      if (!usuario && !actual?.passwordCifrada) return undefined;
      return {
        usuario,
        passwordCifrada: actual?.passwordCifrada,
        passwordPreview: actual?.passwordPreview,
      };
    }
    return {
      usuario,
      passwordCifrada: this.secretCipher.encrypt(dto.password),
      passwordPreview: `····${dto.password.slice(-4)}`,
    };
  }

  /**
   * Saca `passwordCifrada` de la respuesta antes de mandarla al Frontend —
   * solo `usuario`/`passwordPreview` salen de este service, mismo criterio
   * que `IntegracionesService.toMasked`. Acepta el objeto plano ya armado
   * por `attachResponsablesEfectivos` o `cliente.toObject()`.
   */
  private sanitizeCredenciales(obj: Record<string, unknown>): Record<string, unknown> {
    for (const organismo of ORGANISMOS) {
      const cred = obj[organismo] as CredencialOrganismo | undefined;
      if (cred) {
        obj[organismo] = { usuario: cred.usuario, passwordPreview: cred.passwordPreview };
      }
    }
    return obj;
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
        .populate('responsableTitularId', 'nombre email')
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
      .populate('responsableTitularId', 'nombre email')
      .exec();
    if (!cliente) {
      throw new NotFoundException('Cliente no encontrado');
    }
    return cliente;
  }

  /**
   * Un mismo email no puede repetirse entre dos Clientes distintos (pedido
   * explícito del usuario: "es un único mismo mail por cliente"). A
   * propósito NO se compara contra `User.email` de Personal: la misma
   * persona puede ser Personal y Cliente a la vez con el mismo email (dos
   * roles, ver `esTitular`/"Personal a cargo"), eso no es un duplicado.
   */
  private async validarEmailUnico(email: string, excluirClienteId?: Types.ObjectId): Promise<void> {
    const emailNormalizado = email.toLowerCase().trim();
    const filter: FilterQuery<ClienteDocument> = { email: emailNormalizado };
    if (excluirClienteId) {
      filter._id = { $ne: excluirClienteId };
    }
    const existente = await this.clienteModel.findOne(filter).exec();
    if (existente) {
      throw new ConflictException('Ya existe un cliente con ese email');
    }
  }

  async create(dto: CreateClienteDto, estudioId: Types.ObjectId): Promise<Record<string, unknown>> {
    const cuit = normalizeCuit(dto.cuit);
    const existing = await this.clienteModel.findOne({ cuit }).exec();
    if (existing) {
      throw new ConflictException('Ya existe un cliente con ese CUIT');
    }
    if (dto.email) {
      await this.validarEmailUnico(dto.email);
    }
    await this.validarMotorIaPreferido(dto, estudioId);

    const { credencialesArca, credencialesArba, credencialesAgip, ...rest } = dto;
    const cliente = await this.clienteModel.create({
      ...rest,
      cuit,
      estudioId,
      credencialesArca: this.aplicarCredencial(undefined, credencialesArca),
      credencialesArba: this.aplicarCredencial(undefined, credencialesArba),
      credencialesAgip: this.aplicarCredencial(undefined, credencialesAgip),
    });
    const obj =
      typeof (cliente as ClienteDocument).toObject === 'function'
        ? ((cliente as ClienteDocument).toObject() as unknown as Record<string, unknown>)
        : ({ ...cliente } as Record<string, unknown>);
    return this.sanitizeCredenciales(obj);
  }

  async update(
    id: string,
    dto: UpdateClienteDto,
    estudioId: Types.ObjectId,
  ): Promise<Record<string, unknown>> {
    const cliente = await this.findOneDocument(id, estudioId);
    if (dto.email && dto.email.toLowerCase().trim() !== cliente.email) {
      await this.validarEmailUnico(dto.email, cliente._id);
    }
    await this.validarMotorIaPreferido(dto, estudioId);
    const { responsableIds, credencialesArca, credencialesArba, credencialesAgip, ...rest } = dto;
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
    // Mismo criterio: `undefined` = no tocar; con el campo presente,
    // `aplicarCredencial` decide si reemplaza la contraseña o solo el
    // usuario (ver el comentario ahí).
    if (credencialesArca !== undefined) {
      cliente.credencialesArca = this.aplicarCredencial(cliente.credencialesArca, credencialesArca);
    }
    if (credencialesArba !== undefined) {
      cliente.credencialesArba = this.aplicarCredencial(cliente.credencialesArba, credencialesArba);
    }
    if (credencialesAgip !== undefined) {
      cliente.credencialesAgip = this.aplicarCredencial(cliente.credencialesAgip, credencialesAgip);
    }
    await cliente.save();
    // `responsableIds` quedó con ObjectIds sin poblar tras el `save()` (se
    // reasignó arriba con IDs crudos) — hace falta volver a poblarlo antes
    // de armar `responsablesEfectivos`, si no `attachResponsablesEfectivos`
    // ve objetos sin `nombre`/`email`. Mismo problema si `responsableTitularId`
    // vino en el body: `Object.assign` lo reasigna como ObjectId crudo
    // (Mongoose lo castea solo), perdiendo el populate que traía de
    // `findOneDocument`.
    await cliente.populate('responsableIds', 'nombre email');
    await cliente.populate('responsableTitularId', 'nombre email');
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

    const emailLogin = cliente.email.toLowerCase().trim();
    const usuarioExistente = await this.userModel.findOne({ clienteId: cliente._id }).exec();
    if (usuarioExistente && usuarioExistente.activo) {
      throw new ConflictException('Este cliente ya tiene un usuario de portal creado');
    }

    const yaExisteEseLogin = await this.userModel
      .findOne({ email: emailLogin, _id: { $ne: usuarioExistente?._id } })
      .exec();
    if (yaExisteEseLogin) {
      throw new ConflictException('Ya existe un usuario con ese email');
    }

    const password = generarPasswordSegura();
    let usuario: UserDocument;

    if (usuarioExistente) {
      // Repara un usuario de portal viejo y desactivado (ej. login institucional
      // armado antes del cambio a email real, ver el CLAUDE.md del Frontend "el
      // portal de Cliente deja de tener login institucional") en vez de chocar con
      // el `ConflictException` de arriba — casos reales: Agrocentral SRL, Alonso
      // Federico, Alvarez Nicolas, sin ningún email real cargado en ese momento.
      usuarioExistente.email = emailLogin;
      usuarioExistente.emailInstitucional = undefined;
      usuarioExistente.passwordHash = await argon2.hash(password);
      usuarioExistente.credencialesGeneradas = true;
      usuarioExistente.activo = true;
      await usuarioExistente.save();
      usuario = usuarioExistente;
    } else {
      const rolCliente = await this.roleModel.findOne({ nombre: 'cliente' }).exec();
      if (!rolCliente) {
        throw new BadRequestException('No se encontró el rol de sistema "cliente"');
      }

      usuario = await this.userModel.create({
        email: emailLogin,
        passwordHash: await argon2.hash(password),
        credencialesGeneradas: true,
        nombre: cliente.nombre,
        roleIds: [rolCliente._id],
        clienteId: cliente._id,
        estudioId,
      });
    }

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

  /**
   * "Ver contraseña" de Credenciales (ARCA/ARBA/AGIP) — pedido explícito del
   * usuario: a diferencia de la contraseña de login del portal/Personal
   * (nunca recuperable, solo regenerable, ver `regenerarPasswordPortal`),
   * ARCA/ARBA/AGIP son credenciales del estudio para entrar a un sitio
   * externo (el organismo fiscal) — el equipo necesita poder volver a
   * escribirlas ahí, así que tienen que ser recuperables de verdad. Por eso
   * `SecretCipherService` las cifra reversible (AES-256-GCM) en vez de
   * hashearlas. Nunca se descifran como parte de `GET /clientes` (lista o
   * detalle, ver `sanitizeCredenciales`) — solo acá, bajo demanda, cuando el
   * usuario hace clic en el ojo de un organismo puntual.
   */
  async revelarCredencial(
    id: string,
    organismo: 'arca' | 'arba' | 'agip',
    estudioId: Types.ObjectId,
  ): Promise<{ usuario?: string; password: string }> {
    const cliente = await this.findOneDocument(id, estudioId);
    const campo = `credenciales${organismo[0].toUpperCase()}${organismo.slice(1)}` as (typeof ORGANISMOS)[number];
    const credencial = cliente[campo];
    if (!credencial?.passwordCifrada) {
      throw new NotFoundException(`Este cliente todavía no tiene una contraseña de ${organismo.toUpperCase()} cargada`);
    }
    return {
      usuario: credencial.usuario,
      password: this.secretCipher.decrypt(credencial.passwordCifrada),
    };
  }
}
