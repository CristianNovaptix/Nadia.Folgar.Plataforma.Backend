import { PermissionCode } from '../constants/permissions';

export type UserRole = 'admin' | 'contador' | 'cliente';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  roles: UserRole[];
  permissions: PermissionCode[];
  estudioId: string;
  clienteId?: string;
  /**
   * `true` cuando un admin le reseteó la contraseña a esta cuenta
   * (`UsersService.regenerarPassword`/`ClientesService.regenerarPasswordPortal`,
   * "Cambiar contraseña" del menú de Personal/Clientes) — el Frontend
   * bloquea el resto de la app hasta que cambie esa contraseña temporal por
   * una propia (`RequireAuth`). Se limpia en `UsersService.changeOwnPassword`.
   */
  debeCambiarPassword: boolean;
}
