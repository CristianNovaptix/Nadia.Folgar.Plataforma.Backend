import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/permissions';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { AlertasTareasService } from './alertas-tareas.service';
import { QueryAlertasVencimientoDto } from './dto/query-alertas-vencimiento.dto';
import { UpdateAlertaTareaDto } from './dto/update-alerta-tarea.dto';

/**
 * Notificaciones de la campanita del Inicio (tareas vencidas / por vencer),
 * con estado propio por usuario: leída, papelera y eliminación definitiva.
 */
@ApiTags('iva-tareas')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions(PERMISSIONS.IVA_TAREAS_READ)
@Controller('alertas-tareas')
export class AlertasTareasController {
  constructor(private readonly alertasTareasService: AlertasTareasService) {}

  @Get()
  listar(@Query() query: QueryAlertasVencimientoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.alertasTareasService.listar(
      new Types.ObjectId(user.estudioId),
      new Types.ObjectId(user.userId),
      query.horas ?? 48,
    );
  }

  @Post('marcar-todas-leidas')
  marcarTodasLeidas(
    @Query() query: QueryAlertasVencimientoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.alertasTareasService.marcarTodasLeidas(
      new Types.ObjectId(user.estudioId),
      new Types.ObjectId(user.userId),
      query.horas ?? 48,
    );
  }

  /** Marcar leída/no leída, mandar a la papelera o restaurarla (`enPapelera: false`). */
  @Patch(':tareaId')
  actualizar(
    @Param('tareaId') tareaId: string,
    @Body() dto: UpdateAlertaTareaDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.alertasTareasService.actualizar(
      new Types.ObjectId(user.estudioId),
      new Types.ObjectId(user.userId),
      tareaId,
      dto,
    );
  }

  /** Eliminación definitiva: la notificación no vuelve a aparecer (salvo que cambie el vencimiento de la tarea). */
  @Delete(':tareaId')
  eliminar(@Param('tareaId') tareaId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.alertasTareasService.actualizar(
      new Types.ObjectId(user.estudioId),
      new Types.ObjectId(user.userId),
      tareaId,
      { eliminada: true, enPapelera: false },
    );
  }
}
