import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/permissions';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { ProveedorIA } from '../common/enums/proveedor-ia.enum';
import { IntegracionesService } from './integraciones.service';
import { ConectarIntegracionDto } from './dto/conectar-integracion.dto';
import { SetMotorPorDefectoDto } from './dto/set-motor-por-defecto.dto';
import { UpdateConfigNotificacionesDto } from './dto/update-config-notificaciones.dto';

@ApiTags('configuracion')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('configuracion')
export class IntegracionesController {
  constructor(private readonly integracionesService: IntegracionesService) {}

  @Get('integraciones')
  @Permissions(PERMISSIONS.CONFIGURACION_READ)
  listar(@CurrentUser() user: AuthenticatedUser) {
    return this.integracionesService.listar(new Types.ObjectId(user.estudioId));
  }

  /** Valida la key contra el proveedor real antes de guardarla — nunca persiste una key que no funciona. */
  @Post('integraciones')
  @Permissions(PERMISSIONS.CONFIGURACION_WRITE)
  conectar(@Body() dto: ConectarIntegracionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.integracionesService.conectar(
      new Types.ObjectId(user.estudioId),
      new Types.ObjectId(user.userId),
      dto,
    );
  }

  @Delete('integraciones/:proveedor')
  @Permissions(PERMISSIONS.CONFIGURACION_WRITE)
  desconectar(@Param('proveedor') proveedor: ProveedorIA, @CurrentUser() user: AuthenticatedUser) {
    return this.integracionesService.desconectar(new Types.ObjectId(user.estudioId), proveedor);
  }

  @Patch('motor-por-defecto')
  @Permissions(PERMISSIONS.CONFIGURACION_WRITE)
  setMotorPorDefecto(@Body() dto: SetMotorPorDefectoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.integracionesService.setMotorPorDefecto(
      new Types.ObjectId(user.estudioId),
      dto.proveedor,
    );
  }

  /**
   * Sin `@Permissions` a propósito: cualquier usuario logueado lo lee, porque la
   * campanita del Inicio necesita la anticipación para pedir las tareas por vencer.
   */
  @Get('notificaciones')
  obtenerNotificaciones(@CurrentUser() user: AuthenticatedUser) {
    return this.integracionesService.obtenerConfigNotificaciones(new Types.ObjectId(user.estudioId));
  }

  @Patch('notificaciones')
  @Permissions(PERMISSIONS.CONFIGURACION_WRITE)
  actualizarNotificaciones(
    @Body() dto: UpdateConfigNotificacionesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.integracionesService.actualizarConfigNotificaciones(
      new Types.ObjectId(user.estudioId),
      dto.anticipacionAvisoTareasHoras,
    );
  }
}
