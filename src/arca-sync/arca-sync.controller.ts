import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/permissions';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { ArcaSyncService } from './arca-sync.service';

/**
 * Pestaña ARCA de "Notificaciones" del Frontend. Nunca devuelve la clave
 * fiscal: solo el estado de la última sincronización y los 4 bloques leídos.
 */
@ApiTags('arca-sync')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('arca-sync')
export class ArcaSyncController {
  constructor(private readonly arcaSyncService: ArcaSyncService) {}

  @Get()
  @Permissions(PERMISSIONS.NOTIFICACIONES_READ)
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.arcaSyncService.findAll(new Types.ObjectId(user.estudioId));
  }

  @Get(':clienteId')
  @Permissions(PERMISSIONS.NOTIFICACIONES_READ)
  findOne(@Param('clienteId') clienteId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.arcaSyncService.findOne(clienteId, new Types.ObjectId(user.estudioId));
  }

  /** "Actualizar ahora": no espera a la sincronización automática diaria. */
  @Post(':clienteId/sincronizar')
  @Permissions(PERMISSIONS.NOTIFICACIONES_WRITE)
  sincronizar(@Param('clienteId') clienteId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.arcaSyncService.sincronizarCliente(clienteId, new Types.ObjectId(user.estudioId));
  }
}
