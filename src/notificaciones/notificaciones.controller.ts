import {
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
import { NotificacionesService } from './notificaciones.service';
import { CreateVencimientoDto } from './dto/create-vencimiento.dto';
import { UpdateVencimientoDto } from './dto/update-vencimiento.dto';
import { QueryVencimientoDto } from './dto/query-vencimiento.dto';
import { CreateReglaNotificacionDto } from './dto/create-regla-notificacion.dto';
import { UpdateReglaNotificacionDto } from './dto/update-regla-notificacion.dto';
import { QueryReglaNotificacionDto } from './dto/query-regla-notificacion.dto';
import { QueryNotificacionEnviadaDto } from './dto/query-notificacion-enviada.dto';

@ApiTags('notificaciones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('notificaciones')
export class NotificacionesController {
  constructor(private readonly notificacionesService: NotificacionesService) {}

  // ── Vencimientos ──────────────────────────────────────────────────────

  @Get('vencimientos')
  @Permissions(PERMISSIONS.NOTIFICACIONES_READ)
  findAllVencimientos(@Query() query: QueryVencimientoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.notificacionesService.findAllVencimientos(
      query,
      new Types.ObjectId(user.estudioId),
    );
  }

  @Get('vencimientos/:id')
  @Permissions(PERMISSIONS.NOTIFICACIONES_READ)
  findOneVencimiento(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notificacionesService.findOneVencimiento(id, new Types.ObjectId(user.estudioId));
  }

  @Post('vencimientos')
  @Permissions(PERMISSIONS.NOTIFICACIONES_WRITE)
  createVencimiento(@Body() dto: CreateVencimientoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.notificacionesService.createVencimiento(dto, new Types.ObjectId(user.estudioId));
  }

  @Patch('vencimientos/:id')
  @Permissions(PERMISSIONS.NOTIFICACIONES_WRITE)
  updateVencimiento(
    @Param('id') id: string,
    @Body() dto: UpdateVencimientoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notificacionesService.updateVencimiento(
      id,
      dto,
      new Types.ObjectId(user.estudioId),
    );
  }

  @Delete('vencimientos/:id')
  @Permissions(PERMISSIONS.NOTIFICACIONES_WRITE)
  removeVencimiento(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notificacionesService.removeVencimiento(id, new Types.ObjectId(user.estudioId), user.userId);
  }

  // ── Reglas de notificación ───────────────────────────────────────────

  @Get('reglas')
  @Permissions(PERMISSIONS.NOTIFICACIONES_READ)
  findAllReglas(@Query() query: QueryReglaNotificacionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.notificacionesService.findAllReglas(query, new Types.ObjectId(user.estudioId));
  }

  @Get('reglas/:id')
  @Permissions(PERMISSIONS.NOTIFICACIONES_READ)
  findOneRegla(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notificacionesService.findOneRegla(id, new Types.ObjectId(user.estudioId));
  }

  @Post('reglas')
  @Permissions(PERMISSIONS.NOTIFICACIONES_WRITE)
  createRegla(@Body() dto: CreateReglaNotificacionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.notificacionesService.createRegla(dto, new Types.ObjectId(user.estudioId));
  }

  @Patch('reglas/:id')
  @Permissions(PERMISSIONS.NOTIFICACIONES_WRITE)
  updateRegla(
    @Param('id') id: string,
    @Body() dto: UpdateReglaNotificacionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notificacionesService.updateRegla(id, dto, new Types.ObjectId(user.estudioId));
  }

  @Delete('reglas/:id')
  @Permissions(PERMISSIONS.NOTIFICACIONES_WRITE)
  removeRegla(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notificacionesService.removeRegla(id, new Types.ObjectId(user.estudioId));
  }

  // ── Historial de notificaciones enviadas (solo lectura) ──────────────

  @Get('historial')
  @Permissions(PERMISSIONS.NOTIFICACIONES_READ)
  findAllHistorial(
    @Query() query: QueryNotificacionEnviadaDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notificacionesService.findAllNotificacionesEnviadas(
      query,
      new Types.ObjectId(user.estudioId),
    );
  }
}
