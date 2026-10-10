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
import { ClienteHistorialService, TIPO_EVENTO } from './cliente-historial.service';

@ApiTags('clientes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('clientes')
export class ClientesController {
  constructor(
    private readonly clientesService: ClientesService,
    private readonly historial: ClienteHistorialService,
  ) {}

  @Get()
  @Permissions(PERMISSIONS.CLIENTES_READ)
  findAll(@Query() query: QueryClienteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.clientesService.findAll(query, new Types.ObjectId(user.estudioId));
  }

  /** "Ver historial" del menú de Clientes — ver `ClienteHistorialService`. */
  @Get(':id/historial')
  @Permissions(PERMISSIONS.CLIENTES_READ)
  historialCliente(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.historial.listar(id, new Types.ObjectId(user.estudioId));
  }

  @Get(':id')
  @Permissions(PERMISSIONS.CLIENTES_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.clientesService.findOne(id, new Types.ObjectId(user.estudioId));
  }

  @Post()
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  async create(@Body() dto: CreateClienteDto, @CurrentUser() user: AuthenticatedUser) {
    const estudioId = new Types.ObjectId(user.estudioId);
    const cliente = await this.clientesService.create(dto, estudioId);
    const clienteId = cliente._id as Types.ObjectId;
    await this.historial.registrar(
      clienteId,
      estudioId,
      { tipo: TIPO_EVENTO.CLIENTE_CREADO, descripcion: 'Se dio de alta el cliente', origenId: new Types.ObjectId(clienteId) },
      user.userId,
    );
    return cliente;
  }

  @Patch(':id')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateClienteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const estudioId = new Types.ObjectId(user.estudioId);
    const cliente = await this.clientesService.update(id, dto, estudioId);
    const evento =
      dto.activo === true
        ? { tipo: TIPO_EVENTO.CLIENTE_ACTIVADO, descripcion: 'Se activó el cliente' }
        : dto.activo === false
          ? { tipo: TIPO_EVENTO.CLIENTE_DESACTIVADO, descripcion: 'Se desactivó el cliente' }
          : { tipo: TIPO_EVENTO.CLIENTE_EDITADO, descripcion: 'Se editaron los datos del cliente' };
    await this.historial.registrar(id, estudioId, evento, user.userId);
    return cliente;
  }

  @Delete(':id')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const estudioId = new Types.ObjectId(user.estudioId);
    await this.clientesService.deactivate(id, estudioId);
    await this.historial.registrar(
      id,
      estudioId,
      { tipo: TIPO_EVENTO.CLIENTE_DESACTIVADO, descripcion: 'Se desactivó el cliente' },
      user.userId,
    );
  }

  @Post(':id/papelera')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  async moverAPapelera(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const estudioId = new Types.ObjectId(user.estudioId);
    await this.clientesService.moverAPapelera(id, estudioId);
    await this.historial.registrar(
      id,
      estudioId,
      { tipo: TIPO_EVENTO.CLIENTE_PAPELERA, descripcion: 'Se envió el cliente a la papelera' },
      user.userId,
    );
  }

  @Post(':id/restaurar')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  async restaurarDePapelera(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const estudioId = new Types.ObjectId(user.estudioId);
    await this.clientesService.restaurarDePapelera(id, estudioId);
    await this.historial.registrar(
      id,
      estudioId,
      { tipo: TIPO_EVENTO.CLIENTE_RESTAURADO, descripcion: 'Se restauró el cliente desde la papelera' },
      user.userId,
    );
  }

  @Delete(':id/definitivo')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  eliminarDefinitivamente(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.clientesService.eliminarDefinitivamente(id, new Types.ObjectId(user.estudioId));
  }

  /** "Crear usuario y enviarle las credenciales por email" del alta de Cliente — ver `ClientesService.crearUsuarioPortal`. */
  @Post(':id/usuario-portal')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  async crearUsuarioPortal(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const { usuario, password, emailEnviado } = await this.clientesService.crearUsuarioPortal(
      id,
      new Types.ObjectId(user.estudioId),
    );
    await this.historial.registrar(
      id,
      new Types.ObjectId(user.estudioId),
      {
        tipo: TIPO_EVENTO.USUARIO_PORTAL_CREADO,
        descripcion: `Se creó el usuario del portal${usuario.email ? ` (${usuario.email})` : ''}`,
        origenId: usuario._id,
      },
      user.userId,
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
    await this.historial.registrar(
      id,
      new Types.ObjectId(user.estudioId),
      {
        tipo: TIPO_EVENTO.PASSWORD_PORTAL_CAMBIADA,
        descripcion: emailEnviado
          ? 'Se cambió la contraseña del portal y se le avisó por email'
          : 'Se cambió la contraseña del portal',
      },
      user.userId,
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
