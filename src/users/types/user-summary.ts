import { PermissionCode } from '../../common/constants/permissions';

/**
 * Forma pública de un usuario para pantallas de administración (hoy: Personal
 * del Frontend, `GET/POST/PATCH /users`) — ver `UsersService.toSummary`.
 * A propósito NO expone `passwordHash`: antes de esto `UsersController`
 * devolvía el `UserDocument` de Mongoose tal cual, que sí lo incluye (nadie
 * había conectado el Frontend a `/users` todavía, así que no se había notado).
 */
export interface UserSummary {
  _id: string;
  /** `null` cuando todavía no se cargó — ver el comentario en `user.schema.ts`. No puede loguearse hasta tenerlo. */
  email: string | null;
  /**
   * Login institucional para entrar con contraseña (`nombre.apellido@folgar.com.ar`)
   * — distinto de `email` de arriba, nunca lo pisa. `null` hasta que se le
   * genere uno vía "Crear usuario" (`generarCredencialesDeAcceso`). Ver el
   * comentario en `user.schema.ts`.
   */
  emailInstitucional: string | null;
  /**
   * `true` cuando ya se le generó una contraseña por alguno de los tres
   * flujos de "crear usuario" — el menú de acciones del Frontend lo usa
   * para ofrecer "Mostrar usuario" (regenera y muestra una contraseña
   * nueva) en vez de "Crear usuario"/"Crear usuario institucional". Ver el
   * comentario en `User.credencialesGeneradas` (`user.schema.ts`).
   */
  tieneCredenciales: boolean;
  nombre: string;
  telefono: string | null;
  regimenFiscal: string | null;
  roles: { _id: string; nombre: string }[];
  /**
   * Excepciones de permisos de este usuario, por encima/por debajo de lo que
   * ya dan sus roles — ver el comentario en `user.schema.ts`. `AuthService.
   * buildUserContext` es quien realmente las aplica al token; acá solo se
   * exponen para que la pantalla de administración las pueda editar.
   */
  permisosExtra: PermissionCode[];
  permisosDenegados: PermissionCode[];
  activo: boolean;
  /** `data:<contentType>;base64,<...>` listo para un <img src>, o null si no cargó foto. */
  avatarDataUrl: string | null;
  /**
   * `null` mientras la persona no lo cargue en su propio "Mi perfil" — ver
   * `User.genero`. El Frontend lo usa para mostrar el nombre del rol en la
   * forma correcta ("administrador"/"administradora") en la tabla de
   * Personal; sin él, cae a la forma masculina.
   */
  genero: 'masculino' | 'femenino' | null;
  /** Dueño/a real del estudio (`User.esTitular`) — ver el comentario en `user.schema.ts`. */
  esTitular: boolean;
}
