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
import { IvaTareasService } from './iva-tareas.service';
import { CreateTareaPresentacionDto } from './dto/create-tarea-presentacion.dto';
import { UpdateTareaPresentacionDto } from './dto/update-tarea-presentacion.dto';
import { QueryTareaPresentacionDto } from './dto/query-tarea-presentacion.dto';
import { QueryKanbanDto } from './dto/query-kanban.dto';
import { MoverTareaDto } from './dto/mover-tarea.dto';
import { GenerarTareasDto } from './dto/generar-tareas.dto';
import { AnalizarDocumentoTareasDto } from './dto/analizar-documento-tareas.dto';
import { ImportarTareasDocumentoDto } from './dto/importar-tareas-documento.dto';
import { CreateTareaAdjuntoDto } from './dto/create-tarea-adjunto.dto';

@ApiTags('iva-tareas')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('iva-tareas')
export class IvaTareasController {
  constructor(private readonly ivaTareasService: IvaTareasService) {}

  @Get('kanban')
  @Permissions(PERMISSIONS.IVA_TAREAS_READ)
  findKanban(@Query() query: QueryKanbanDto, @CurrentUser() user: AuthenticatedUser) {
    return this.ivaTareasService.findKanban(new Types.ObjectId(user.estudioId), query);
  }

  @Get()
  @Permissions(PERMISSIONS.IVA_TAREAS_READ)
  findAll(@Query() query: QueryTareaPresentacionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.ivaTareasService.findAllTareas(query, new Types.ObjectId(user.estudioId));
  }

  /**
   * Declarada antes de `:id` a propósito — si no, Nest la matchea contra esa
   * ruta y trata "miembros" como si fuera un id (mismo criterio que 'kanban').
   */
  @Get('miembros')
  @Permissions(PERMISSIONS.IVA_TAREAS_READ)
  miembros() {
    return this.ivaTareasService.findMiembrosDelTablero();
  }

  @Get(':id')
  @Permissions(PERMISSIONS.IVA_TAREAS_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ivaTareasService.findOneTarea(id, new Types.ObjectId(user.estudioId));
  }

  @Post()
  @Permissions(PERMISSIONS.IVA_TAREAS_WRITE)
  create(@Body() dto: CreateTareaPresentacionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.ivaTareasService.createTarea(
      dto,
      new Types.ObjectId(user.estudioId),
      new Types.ObjectId(user.userId),
    );
  }

  @Post('generar')
  @Permissions(PERMISSIONS.IVA_TAREAS_WRITE)
  generar(@Body() dto: GenerarTareasDto, @CurrentUser() user: AuthenticatedUser) {
    return this.ivaTareasService.generarTareasDelMes(
      dto.periodo,
      new Types.ObjectId(user.estudioId),
    );
  }

  /**
   * Análisis previo (sin persistir nada) de "Importar tareas desde
   * documento": la IA lee el documento y propone una lista de tareas que el
   * Frontend muestra en el paso de revisión — recién se crean con
   * `importarDocumentoConfirmar`. Declarada como ruta literal, así que no
   * choca con `:id` (solo hay `:id` en rutas GET, acá son todas POST).
   */
  @Post('importar-documento/analizar')
  @Permissions(PERMISSIONS.IVA_TAREAS_WRITE)
  importarDocumentoAnalizar(@Body() dto: AnalizarDocumentoTareasDto) {
    return this.ivaTareasService.analizarDocumento(dto);
  }

  /** Confirma la importación: crea una tarjeta por cada tarea del lote, todas en "Pendiente" para el cliente elegido. */
  @Post('importar-documento/confirmar')
  @Permissions(PERMISSIONS.IVA_TAREAS_WRITE)
  importarDocumentoConfirmar(
    @Body() dto: ImportarTareasDocumentoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ivaTareasService.importarTareasDocumento(
      dto,
      new Types.ObjectId(user.estudioId),
      new Types.ObjectId(user.userId),
    );
  }

  @Patch(':id/mover')
  @Permissions(PERMISSIONS.IVA_TAREAS_WRITE)
  mover(
    @Param('id') id: string,
    @Body() dto: MoverTareaDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ivaTareasService.moverTarea(id, dto, new Types.ObjectId(user.estudioId));
  }

  @Patch(':id')
  @Permissions(PERMISSIONS.IVA_TAREAS_WRITE)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTareaPresentacionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ivaTareasService.updateTarea(id, dto, new Types.ObjectId(user.estudioId));
  }

  @Delete(':id')
  @Permissions(PERMISSIONS.IVA_TAREAS_WRITE)
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ivaTareasService.removeTarea(id, new Types.ObjectId(user.estudioId));
  }

  // ── Adjuntos ────────────────────────────────────────────────────────

  @Get(':id/adjuntos')
  @Permissions(PERMISSIONS.IVA_TAREAS_READ)
  findAdjuntos(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ivaTareasService.findAdjuntos(id, new Types.ObjectId(user.estudioId));
  }

  @Post(':id/adjuntos')
  @Permissions(PERMISSIONS.IVA_TAREAS_WRITE)
  addAdjunto(
    @Param('id') id: string,
    @Body() dto: CreateTareaAdjuntoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ivaTareasService.addAdjunto(
      id,
      dto,
      new Types.ObjectId(user.estudioId),
      new Types.ObjectId(user.userId),
    );
  }

  @Delete(':id/adjuntos/:adjuntoId')
  @Permissions(PERMISSIONS.IVA_TAREAS_WRITE)
  removeAdjunto(
    @Param('id') id: string,
    @Param('adjuntoId') adjuntoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ivaTareasService.removeAdjunto(id, adjuntoId, new Types.ObjectId(user.estudioId));
  }
}
