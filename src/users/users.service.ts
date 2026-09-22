import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as argon2 from 'argon2';
import { MailService } from '../common/mail/mail.service';
import { generarPasswordSegura } from '../common/utils/password.util';
import { DOMINIO_INSTITUCIONAL, slugDesdeNombre } from '../common/utils/email-institucional.util';
import { User, UserDocument } from './schemas/user.schema';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateAvatarDto } from './dto/update-avatar.dto';
import { UserProfile } from './types/user-profile';
import { UserSummary } from './types/user-summary';
import { RoleDocument } from '../roles/schemas/role.schema';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly mailService: MailService,
  ) {}

  findAll(): Promise<UserDocument[]> {
    return this.userModel.find().populate('roleIds').exec();
  }

  async findOne(id: string): Promise<UserDocument> {
    const user = await this.userModel.findById(id).populate('roleIds').exec();
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return user;
  }

  /**
   * Usado para autenticar (password y social) — matchea tanto contra el
   * email real (`email`, el que usa el login social y adonde llegan los
   * avisos) como contra el institucional (`emailInstitucional`, el que se
   * arma para entrar con contraseña — ver `generarCredencialesDeAcceso`).
   * El proveedor social solo va a mandar el real, nunca el institucional,
   * así que esto no abre ninguna vía nueva de login social.
   */
  findByEmail(email: string): Promise<UserDocument | null> {
    const normalizado = email.toLowerCase().trim();
    return this.userModel
      .findOne({ $or: [{ email: normalizado }, { emailInstitucional: normalizado }] })
      .populate('roleIds')
      .exec();
  }

  /** Ninguna cuenta tiene ya este email candidato, ni como real (`email`) ni como institucional. */
  private async emailInstitucionalDisponible(email: string): Promise<boolean> {
    const existe = await this.userModel
      .findOne({ $or: [{ email }, { emailInstitucional: email }] })
      .exec();
    return !existe;
  }

  async create(dto: CreateUserDto, estudioId: Types.ObjectId): Promise<UserDocument> {
    const email = dto.email?.toLowerCase().trim();
    if (email) {
      const existing = await this.userModel.findOne({ email }).exec();
      if (existing) {
        throw new ConflictException('Ya existe un usuario con ese email');
      }
    }

    const passwordHash = await argon2.hash(dto.password);

    const created = await this.userModel.create({
      email,
      passwordHash,
      nombre: dto.nombre,
      roleIds: dto.roleIds,
      clienteId: dto.clienteId,
      telefono: dto.telefono,
      regimenFiscal: dto.regimenFiscal,
      estudioId,
    });
    // Para que `toSummary` pueda leer los nombres de rol del usuario recién
    // creado sin un segundo viaje a la base — mismo criterio que `findAll`/
    // `findOne`, que ya populan `roleIds`.
    await created.populate('roleIds');
    return created;
  }

  async update(id: string, dto: UpdateUserDto): Promise<UserDocument> {
    const user = await this.findOne(id);

    // Mismo chequeo de duplicado que ya tenía `updateOwnProfile` — acá no
    // existía (el `Object.assign` de abajo se lo hubiera dejado directo a
    // Mongo, que sí lo iba a rechazar por el índice único, pero con un
    // `MongoServerError` crudo en vez de un `ConflictException` claro).
    // Necesario desde que "Personal" permite completar el email más tarde
    // vía `PATCH /users/:id` (antes ese campo no se tocaba nunca desde acá).
    const { email: emailDto, ...resto } = dto;
    if (emailDto !== undefined) {
      const email = emailDto?.toLowerCase().trim() || undefined;
      if (email && email !== user.email) {
        const existing = await this.userModel.findOne({ email, _id: { $ne: user._id } }).exec();
        if (existing) {
          throw new ConflictException('Ya existe un usuario con ese email');
        }
      }
      user.email = email;
    }

    Object.assign(user, resto);
    await user.save();
    return user;
  }

  async deactivate(id: string): Promise<void> {
    const user = await this.findOne(id);
    user.activo = false;
    await user.save();
  }

  /**
   * "Crear usuario institucional" de la pantalla Personal del Frontend —
   * pedido explícito del usuario: dar de alta la cuenta de acceso de un
   * integrante que ya existe como "Personal" pero todavía no tiene email
   * (ver el caso real de Nadia Folgar, documentada sin email en el CLAUDE.md
   * del Frontend) sin tener que inventarle ningún dato — arma un email
   * `nombre.apellido@folgar.com.ar` a partir del nombre ya cargado (con un
   * sufijo numérico si ese email ya existe) y una contraseña al azar seria,
   * ambos completables por la propia persona una vez que entra (ver "Mi
   * perfil"). No se manda por ningún canal automático (no hay envío de
   * email en el Backend todavía) — se devuelve una única vez en la
   * respuesta para que el administrador se la pase a mano.
   *
   * También guarda ese mismo valor en `emailInstitucional` (además de
   * `email`) — antes solo quedaba en `email`, y el Frontend no tenía forma
   * de distinguir "este `email` es en realidad el login institucional
   * autogenerado, no un email personal real" (bug real reportado por el
   * usuario: en "Datos personales" del formulario de Personal, el campo
   * "Email" — pensado para el email personal — terminaba mostrando este
   * valor institucional para quien pasó por acá, ver `PersonalFormDialog`
   * del Frontend). Con `emailInstitucional` también seteado, el Frontend
   * compara `email === emailInstitucional` para saber si todavía no se
   * cargó un email personal de verdad. Si esta persona más adelante carga
   * su email real (`UsersService.update`), `email` cambia pero
   * `emailInstitucional` queda intacto — el login por contraseña con el
   * institucional sigue funcionando igual.
   */
  async generarCredencialesInstitucionales(
    id: string,
  ): Promise<{ user: UserDocument; password: string }> {
    const user = await this.findOne(id);
    if (user.email) {
      throw new ConflictException('Este integrante ya tiene un email institucional cargado');
    }

    const base = slugDesdeNombre(user.nombre);
    let email = `${base}@${DOMINIO_INSTITUCIONAL}`;
    let sufijo = 2;
    while (!(await this.emailInstitucionalDisponible(email))) {
      email = `${base}${sufijo}@${DOMINIO_INSTITUCIONAL}`;
      sufijo += 1;
    }

    const password = generarPasswordSegura();
    user.email = email;
    user.emailInstitucional = email;
    user.passwordHash = await argon2.hash(password);
    user.credencialesGeneradas = true;
    await user.save();

    return { user, password };
  }

  /**
   * "Crear usuario" del menú de "Personal" del Frontend — pedido explícito
   * del usuario, para un integrante que YA tiene su email real cargado (a
   * diferencia de `generarCredencialesInstitucionales`, para quien no tiene
   * ninguno). Ese email real **nunca se pisa** — sigue siendo con el que
   * entra por Google/LinkedIn/Apple y adonde le llega el aviso — el login
   * por contraseña es uno institucional nuevo, guardado aparte en
   * `emailInstitucional` (ver el comentario en `user.schema.ts`). Ambos
   * campos quedan visibles y diferenciados en todo momento, nunca se
   * mezclan — corrección explícita del usuario sobre un primer intento que
   * sí pisaba `email`.
   */
  async generarCredencialesDeAcceso(id: string): Promise<{
    user: UserDocument;
    emailInstitucional: string;
    password: string;
    emailEnviado: boolean;
  }> {
    const user = await this.findOne(id);
    if (!user.email) {
      throw new BadRequestException(
        'Este integrante necesita un email cargado para poder enviarle las credenciales',
      );
    }

    const base = slugDesdeNombre(user.nombre);
    let emailInstitucional = `${base}@${DOMINIO_INSTITUCIONAL}`;
    let sufijo = 2;
    while (!(await this.emailInstitucionalDisponible(emailInstitucional))) {
      emailInstitucional = `${base}${sufijo}@${DOMINIO_INSTITUCIONAL}`;
      sufijo += 1;
    }

    const password = generarPasswordSegura();
    user.emailInstitucional = emailInstitucional;
    user.passwordHash = await argon2.hash(password);
    user.credencialesGeneradas = true;
    await user.save();

    const emailEnviado = await this.mailService.enviarCredenciales({
      to: user.email,
      usuario: emailInstitucional,
      nombre: user.nombre,
      password,
      esCliente: false,
    });

    return { user, emailInstitucional, password, emailEnviado };
  }

  /**
   * "Cambiar contraseña" del menú de "Personal" — pedido explícito del
   * usuario: para un integrante que YA tiene una cuenta creada
   * (`credencialesGeneradas`), en vez de "Crear usuario"/"Crear usuario
   * institucional" (que no tendría sentido repetir). El Backend nunca
   * guarda la contraseña original de forma recuperable (ver el comentario
   * en `User.credencialesGeneradas`), así que esto no "recupera" la de
   * antes — deja una nueva como vigente (la que mande el admin en
   * `password`, o una generada si no mandó ninguna) sin tocar el email de
   * login (institucional o real, el que ya tuviera). Marca
   * `debeCambiarPassword` para que esa contraseña sea de un solo uso: la
   * persona tiene que cambiarla por una propia en su próximo login antes de
   * poder usar el resto de la plataforma. Le avisa por mail a `user.email`
   * (nunca al institucional) — mismo criterio que `generarCredencialesDeAcceso`.
   */
  async regenerarPassword(
    id: string,
    passwordManual?: string,
  ): Promise<{ user: UserDocument; password: string; emailEnviado: boolean }> {
    const user = await this.findOne(id);
    if (!user.credencialesGeneradas) {
      throw new BadRequestException('Este integrante todavía no tiene ninguna cuenta creada');
    }

    const password = passwordManual || generarPasswordSegura();
    const loginVigente = user.emailInstitucional ?? user.email ?? '';
    user.passwordHash = await argon2.hash(password);
    user.debeCambiarPassword = true;
    await user.save();

    // Sin un email real distinto del institucional (caso "Crear usuario
    // institucional" para quien nunca cargó uno propio — ver el comentario
    // en `generarCredencialesInstitucionales`), no hay a dónde mandar el
    // aviso: esa dirección no es una casilla real que alguien lea.
    const emailReal = user.email && user.email !== user.emailInstitucional ? user.email : null;
    const emailEnviado = emailReal
      ? await this.mailService.enviarCredenciales({
          to: emailReal,
          usuario: loginVigente,
          nombre: user.nombre,
          password,
          esCliente: false,
        })
      : false;

    return { user, password, emailEnviado };
  }

  // ── Autogestión de "Mi perfil" ──────────────────────────────────────────

  async updateOwnProfile(id: string, dto: UpdateProfileDto): Promise<UserDocument> {
    const user = await this.findOne(id);

    if (dto.email && dto.email.toLowerCase().trim() !== user.email) {
      const email = dto.email.toLowerCase().trim();
      const existing = await this.userModel.findOne({ email, _id: { $ne: user._id } }).exec();
      if (existing) {
        throw new ConflictException('Ya existe un usuario con ese email');
      }
      user.email = email;
    }

    if (dto.nombre !== undefined) user.nombre = dto.nombre;
    if (dto.fechaNacimiento !== undefined) user.fechaNacimiento = new Date(dto.fechaNacimiento);
    if (dto.pais !== undefined) user.pais = dto.pais;
    if (dto.provincia !== undefined) user.provincia = dto.provincia;
    if (dto.ciudad !== undefined) user.ciudad = dto.ciudad;
    if (dto.telefono !== undefined) user.telefono = dto.telefono;
    if (dto.genero !== undefined) user.genero = dto.genero;

    await user.save();
    return user;
  }

  async changeOwnPassword(id: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.findOne(id);

    const valid = await argon2.verify(user.passwordHash, dto.currentPassword);
    if (!valid) {
      throw new UnauthorizedException('La contraseña actual no es correcta');
    }

    user.passwordHash = await argon2.hash(dto.newPassword);
    // Única forma de sacarse de encima el bloqueo de "Cambiar contraseña
    // obligatorio" — ver el comentario en `User.debeCambiarPassword`.
    user.debeCambiarPassword = false;
    await user.save();
  }

  async updateAvatar(id: string, dto: UpdateAvatarDto): Promise<UserDocument> {
    const user = await this.findOne(id);
    user.avatarContentType = dto.contentType;
    user.avatarBase64 = dto.contenidoBase64;
    await user.save();
    return user;
  }

  /**
   * Forma pública de un usuario para `UsersController` (hoy: pantalla
   * Personal del Frontend) — a propósito nunca devuelve `passwordHash`.
   * Requiere que `roleIds` venga poblado (`findAll`/`findOne`/`create` ya lo
   * hacen); si no, cada rol queda con `nombre: ''` en vez de romper.
   */
  toSummary(user: UserDocument): UserSummary {
    const roles = (user.roleIds as unknown as RoleDocument[]).map((role) =>
      role && typeof role === 'object' && 'nombre' in role
        ? { _id: role._id.toString(), nombre: role.nombre }
        : { _id: (role as unknown as Types.ObjectId).toString(), nombre: '' },
    );

    return {
      _id: user._id.toString(),
      email: user.email ?? null,
      emailInstitucional: user.emailInstitucional ?? null,
      // `credencialesGeneradas` es un campo nuevo (default `false`) — para
      // cuentas creadas ANTES de que existiera (con `generarCredencialesDeAcceso`,
      // que sí les dejó `emailInstitucional` cargado) el flag solo no alcanza:
      // sin este `||`, el menú de "Personal" les seguía ofreciendo "Crear
      // usuario" en vez de "Mostrar usuario", y volver a generarlas les pisaba
      // el login institucional ya existente por uno nuevo con sufijo "2" (bug
      // real reportado por el usuario) en vez de reconocer que ya tenían uno.
      tieneCredenciales: Boolean(user.credencialesGeneradas) || Boolean(user.emailInstitucional),
      nombre: user.nombre,
      telefono: user.telefono ?? null,
      regimenFiscal: user.regimenFiscal ?? null,
      roles,
      permisosExtra: user.permisosExtra ?? [],
      permisosDenegados: user.permisosDenegados ?? [],
      activo: user.activo,
      avatarDataUrl:
        user.avatarContentType && user.avatarBase64
          ? `data:${user.avatarContentType};base64,${user.avatarBase64}`
          : null,
      genero: user.genero ?? null,
      // Para que el selector de "Responsable" de `ClienteFormDialog` (Frontend)
      // pueda preseleccionar solo al/los titular/es como default, sin tener
      // que pedirle a `ClientesService` esa información aparte — mismo
      // criterio que ya usa `ClientesService.findResponsablesAutomaticos`.
      esTitular: Boolean(user.esTitular),
    };
  }

  toProfileResponse(user: UserDocument): UserProfile {
    // Mismo motivo que en `AuthService.buildUserContext`: `email` es opcional
    // en el schema, pero acá siempre debería estar — "Mi perfil" es del
    // propio usuario ya autenticado, y solo se autentica quien tiene email.
    if (!user.email) {
      throw new UnauthorizedException('El usuario no tiene un email asociado');
    }

    return {
      userId: user._id.toString(),
      email: user.email,
      nombre: user.nombre,
      fechaNacimiento: user.fechaNacimiento ? user.fechaNacimiento.toISOString() : null,
      pais: user.pais ?? null,
      provincia: user.provincia ?? null,
      ciudad: user.ciudad ?? null,
      telefono: user.telefono ?? null,
      genero: user.genero ?? null,
      avatarDataUrl:
        user.avatarContentType && user.avatarBase64
          ? `data:${user.avatarContentType};base64,${user.avatarBase64}`
          : null,
    };
  }
}
