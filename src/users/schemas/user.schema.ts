import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';
import { RegimenFiscal } from '../../clientes/schemas/cliente.schema';

export type UserDocument = HydratedDocument<User>;

/** Autogestionable desde "Mi perfil" — ver el campo `genero` más abajo. */
export type Genero = 'masculino' | 'femenino';

@Schema(baseSchemaOptions)
export class User {
  /**
   * Opcional a propósito (pedido explícito del usuario, ver `features/personal`
   * del Frontend): un integrante de "Personal" se puede dar de alta sin saber
   * todavía su email real — nunca se inventa uno — y completarlo después vía
   * `PATCH /users/:id`. Mientras no tenga email no puede loguearse por ningún
   * medio (ni password, que ya no se autogestiona por acá, ni login social,
   * que matchea por email en `AuthService.loginWithSocialCode`) — es
   * exactamente lo esperado, no un caso a resolver. `sparse: true` en el
   * índice único es necesario: sin eso, Mongo trata "sin email" como el mismo
   * valor `null` para el índice y el segundo usuario sin email chocaría con
   * el primero.
   */
  @Prop({ unique: true, sparse: true, lowercase: true, trim: true, required: false })
  email?: string;

  /**
   * Login institucional (`nombre.apellido@folgar.com.ar`) para entrar con
   * contraseña — pedido explícito del usuario, campo separado de `email` de
   * arriba y que **nunca** lo pisa: `email` sigue siendo el real (el que ya
   * usa para entrar por Google/LinkedIn/Apple, y adonde le llega el aviso
   * con este login nuevo), este es solo el usuario que hay que escribir en
   * el login por contraseña. Lo arma `UsersService.generarCredencialesDeAcceso`
   * ("Crear usuario" del menú de "Personal", para quien ya tiene `email`
   * real cargado) — distinto de `generarCredencialesInstitucionales`
   * ("Crear usuario institucional", para quien todavía NO tiene ningún
   * email: ahí no hace falta este campo aparte, `email` directamente queda
   * vacío para llenar). `AuthService`/`UsersService.findByEmail` matchean el
   * login por contraseña contra este campo O `email` — el social solo
   * contra `email` real (el proveedor manda esa dirección, no esta).
   * Mismo `sparse: true` que `email` y mismo motivo.
   */
  @Prop({ unique: true, sparse: true, lowercase: true, trim: true, required: false })
  emailInstitucional?: string;

  @Prop({ required: true })
  passwordHash: string;

  /**
   * `true` una vez que a esta cuenta se le generó una contraseña por
   * cualquiera de los tres flujos de "Personal"/"Cliente" (`generarCredencialesInstitucionales`,
   * `generarCredencialesDeAcceso`, `ClientesService.crearUsuarioPortal`) —
   * pedido explícito del usuario: el menú de acciones necesita saber si ya
   * existe una cuenta para ofrecer "Mostrar usuario" en vez de "Crear
   * usuario"/"Crear usuario institucional". Deliberadamente NO guarda la
   * contraseña en sí de ninguna forma recuperable (ni cifrada): la
   * contraseña real se hashea en `passwordHash` (argon2, irreversible) y
   * nunca se vuelve a exponer — "Mostrar usuario" regenera una contraseña
   * nueva en el momento (invalida la anterior) en vez de recuperar la
   * original, justamente para no tener que guardar ningún secreto
   * reversible acá.
   */
  @Prop({ default: false })
  credencialesGeneradas: boolean;

  /**
   * `true` cuando la contraseña vigente la puso un admin a mano (reseteo vía
   * "Cambiar contraseña" del menú de Personal/Clientes,
   * `UsersService.regenerarPassword`/`ClientesService.regenerarPasswordPortal`)
   * — pedido explícito del usuario: esa contraseña es temporal, y la persona
   * tiene que cambiarla por una propia en el primer login antes de poder usar
   * el resto de la plataforma (`RequireAuth` del Frontend bloquea todo lo
   * demás mientras esto sea `true`). Se limpia en `UsersService.changeOwnPassword`,
   * la única forma de sacárselo de encima.
   */
  @Prop({ default: false })
  debeCambiarPassword: boolean;

  @Prop({ required: true })
  nombre: string;

  @Prop({ type: [Types.ObjectId], ref: 'Role', default: [] })
  roleIds: Types.ObjectId[];

  @Prop({ default: true })
  activo: boolean;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true })
  estudioId: Types.ObjectId;

  /** Solo se completa para usuarios con rol "cliente": a qué Cliente del Estudio representan. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Cliente', required: false })
  clienteId?: Types.ObjectId;

  // ── Datos de "Mi perfil" (autogestión, sin backlog FOLGAR asociado — pedido
  // directo del Frontend para la pantalla de perfil de usuario) ─────────────

  @Prop({ required: false })
  fechaNacimiento?: Date;

  @Prop({ trim: true, required: false })
  pais?: string;

  @Prop({ trim: true, required: false })
  provincia?: string;

  @Prop({ trim: true, required: false })
  ciudad?: string;

  @Prop({ trim: true, required: false })
  telefono?: string;

  /**
   * Solo tiene sentido para "Personal" (equipo interno, ver `features/personal`
   * del Frontend): buena parte del equipo del Estudio son monotributistas o
   * responsables inscriptos que facturan como independientes, no empleados en
   * relación de dependencia — mismo enum que `Cliente.regimenFiscal`, gestionado
   * por el administrador vía `PATCH /users/:id`, no autogestionable desde
   * "Mi perfil".
   */
  @Prop({ type: String, enum: RegimenFiscal, required: false })
  regimenFiscal?: RegimenFiscal;

  /**
   * Marca al dueño real del estudio (hoy Nadia Folgar) para la columna
   * "Responsable" de `ClientesPage` (ver `ClientesService.findResponsablesAutomaticos`)
   * — pedido explícito del usuario: quien tenga esto en `true` se suma como
   * responsable de TODOS los clientes, sin asignación manual. A propósito
   * NO se deriva del rol "admin": el estudio tiene una cuenta de admin de
   * desarrollo/pruebas ("Yami", `admin@folgar.com.ar`) con permisos de
   * administrador pero que el usuario pidió explícitamente que NO aparezca
   * en esa columna — de ahí que sea un campo aparte, no "cualquier admin".
   * Sin selector en el Frontend por ahora: se marca a mano contra la base
   * real (mismo criterio que otras migraciones puntuales de este módulo,
   * ver CLAUDE.md), no hay UI para tildarlo/destildarlo todavía.
   */
  @Prop({ default: false })
  esTitular: boolean;

  /**
   * Foto de perfil como base64 directo en Mongo — misma decisión temporal de
   * alcance que `Documento` en portal-clientes (ver la nota ahí): no hay
   * storage de objetos confirmado todavía. `UpdateAvatarDto` le pone un tope
   * de tamaño (`MAX_AVATAR_BYTES`). Reemplazar por una key/URL de storage
   * real junto con `Documento` cuando se defina el proveedor.
   */
  /**
   * Autogestionable desde "Mi perfil" (Frontend) — a diferencia de
   * `regimenFiscal` (que gestiona el administrador desde "Personal"), este
   * lo carga cada usuario sobre sí mismo. Pedido explícito del usuario: el
   * nombre del rol debe mostrarse con la forma correcta según género
   * ("administrador"/"administradora", "contador"/"contadora") en vez de
   * quedar siempre en masculino — ver `capitalizarRol` en el Frontend.
   * Opcional y sin default: mientras nadie lo cargue, el Frontend cae a la
   * forma masculina.
   */
  @Prop({ type: String, enum: ['masculino', 'femenino'], required: false })
  genero?: Genero;

  @Prop({ required: false })
  avatarContentType?: string;

  @Prop({ required: false })
  avatarBase64?: string;
}

export const UserSchema = SchemaFactory.createForClass(User);
