import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/permissions';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { RegenerarPasswordDto } from './dto/regenerar-password.dto';
import { Types } from 'mongoose';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Permissions(PERMISSIONS.USERS_READ)
  async findAll() {
    const users = await this.usersService.findAll();
    return users.map((user) => this.usersService.toSummary(user));
  }

  @Get(':id')
  @Permissions(PERMISSIONS.USERS_READ)
  async findOne(@Param('id') id: string) {
    return this.usersService.toSummary(await this.usersService.findOne(id));
  }

  @Post()
  @Permissions(PERMISSIONS.USERS_WRITE)
  async create(@Body() dto: CreateUserDto, @CurrentUser() currentUser: AuthenticatedUser) {
    const created = await this.usersService.create(dto, new Types.ObjectId(currentUser.estudioId));
    return this.usersService.toSummary(created);
  }

  @Patch(':id')
  @Permissions(PERMISSIONS.USERS_WRITE)
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.usersService.toSummary(await this.usersService.update(id, dto));
  }

  @Delete(':id')
  @Permissions(PERMISSIONS.USERS_WRITE)
  remove(@Param('id') id: string) {
    return this.usersService.deactivate(id);
  }

  /** "Crear usuario institucional" de la pantalla Personal — ver el comentario en `UsersService.generarCredencialesInstitucionales`. */
  @Post(':id/credenciales-institucionales')
  @Permissions(PERMISSIONS.USERS_WRITE)
  async generarCredencialesInstitucionales(@Param('id') id: string) {
    const { user, password } = await this.usersService.generarCredencialesInstitucionales(id);
    return { usuario: this.usersService.toSummary(user), password };
  }

  /**
   * "Crear usuario" del menú de Personal — ver `UsersService.generarCredencialesDeAcceso`.
   * El `email` de esta respuesta es el institucional (login por contraseña),
   * NUNCA el real del integrante (`User.email`, que sigue intacto) — es lo
   * que hay que copiarle/pasarle para que entre por contraseña.
   */
  @Post(':id/credenciales-acceso')
  @Permissions(PERMISSIONS.USERS_WRITE)
  async generarCredencialesDeAcceso(@Param('id') id: string) {
    const { user, emailInstitucional, password, emailEnviado } =
      await this.usersService.generarCredencialesDeAcceso(id);
    return {
      usuario: { _id: user._id.toString(), nombre: user.nombre, email: emailInstitucional },
      password,
      emailEnviado,
    };
  }

  /** "Cambiar contraseña" del menú de Personal — ver `UsersService.regenerarPassword`. */
  @Post(':id/regenerar-password')
  @Permissions(PERMISSIONS.USERS_WRITE)
  async regenerarPassword(@Param('id') id: string, @Body() dto: RegenerarPasswordDto) {
    const { user, password, emailEnviado } = await this.usersService.regenerarPassword(
      id,
      dto.password,
    );
    return {
      usuario: {
        _id: user._id.toString(),
        nombre: user.nombre,
        email: user.emailInstitucional ?? user.email ?? null,
      },
      password,
      emailEnviado,
    };
  }
}
