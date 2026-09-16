import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * "Cambiar contraseña" del menú de Personal/Clientes — pedido explícito del
 * usuario: el admin puede escribir una contraseña a mano o dejar la
 * sugerida (armada en el Frontend, ver `sugerirPassword`). Sin `password`,
 * `UsersService.regenerarPassword`/`ClientesService.regenerarPasswordPortal`
 * generan una propia (`generarPasswordSegura`) — mismo comportamiento que
 * tenían antes de aceptar este campo.
 */
export class RegenerarPasswordDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}
