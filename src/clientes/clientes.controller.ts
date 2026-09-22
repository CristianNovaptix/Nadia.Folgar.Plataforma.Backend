import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/permissions';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { ClientesService } from './clientes.service';
import { CreateClienteDto } from './dto/create-cliente.dto';
import { UpdateClienteDto } from './dto/update-cliente.dto';
import { QueryClienteDto } from './dto/query-cliente.dto';
import { RegenerarPasswordDto } from '../users/dto/regenerar-password.dto';

@ApiTags('clientes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('clientes')
export class ClientesController {
  constructor(private readonly clientesService: ClientesService) {}

  @Get()
  @Permissions(PERMISSIONS.CLIENTES_READ)
  findAll(@Query() query: QueryClienteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.clientesService.findAll(query, new Types.ObjectId(user.estudioId));
  }

  @Get(':id')
  @Permissions(PERMISSIONS.CLIENTES_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.clientesService.findOne(id, new Types.ObjectId(user.estudioId));
  }

  @Post()
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  create(@Body() dto: CreateClienteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.clientesService.create(dto, new Types.ObjectId(user.estudioId));
  }

  @Patch(':id')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateClienteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.clientesService.update(id, dto, new Types.ObjectId(user.estudioId));
  }

  @Delete(':id')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.clientesService.deactivate(id, new Types.ObjectId(user.estudioId));
  }

  /** "Crear usuario y enviarle las credenciales por email" del alta de Cliente — ver `ClientesService.crearUsuarioPortal`. */
  @Post(':id/usuario-portal')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  async crearUsuarioPortal(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const { usuario, password, emailEnviado } = await this.clientesService.crearUsuarioPortal(
      id,
      new Types.ObjectId(user.estudioId),
    );
    // Nunca se devuelve el documento de `User` crudo (traería `passwordHash`)
    // — mismo criterio de saneo que `UsersService.toSummary`.
    return {
      usuario: {
        _id: usuario._id.toString(),
        nombre: usuario.nombre,
        email: usuario.email ?? null,
      },
      password,
      emailEnviado,
    };
  }

  /** "Cambiar contraseña" del menú de acciones — ver `ClientesService.regenerarPasswordPortal`. */
  @Post(':id/usuario-portal/regenerar-password')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  async regenerarPasswordPortal(
    @Param('id') id: string,
    @Body() dto: RegenerarPasswordDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { usuario, password, emailEnviado } = await this.clientesService.regenerarPasswordPortal(
      id,
      new Types.ObjectId(user.estudioId),
      dto.password,
    );
    return {
      usuario: {
        _id: usuario._id.toString(),
        nombre: usuario.nombre,
        email: usuario.email ?? null,
      },
      password,
      emailEnviado,
    };
  }

  /** "Ver contraseña" de Credenciales (ARCA/ARBA/AGIP) — ver `ClientesService.revelarCredencial`. */
  @Get(':id/credenciales/:organismo/revelar')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  revelarCredencial(
    @Param('id') id: string,
    @Param('organismo') organismo: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (organismo !== 'arca' && organismo !== 'arba' && organismo !== 'agip') {
      throw new BadRequestException('Organismo inválido');
    }
    return this.clientesService.revelarCredencial(id, organismo, new Types.ObjectId(user.estudioId));
  }
}
