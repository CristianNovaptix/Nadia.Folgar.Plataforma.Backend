import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/permissions';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { InicioService } from './inicio.service';
import {
  CreateGastoDto,
  CreateReunionDto,
  QueryPeriodoDto,
  QueryReunionesDto,
  UpdateGastoDto,
  UpdateReunionDto,
  UpsertImporteManualDto,
} from './dto/inicio.dto';

/**
 * Datos cargados a mano que usa el Inicio (Dashboard). Gastos e importes
 * manuales son información económica del estudio: mismo permiso que
 * Facturación. Reuniones, mismo permiso que Clientes.
 */
@ApiTags('inicio')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('inicio')
export class InicioController {
  constructor(private readonly inicioService: InicioService) {}

  @Get('gastos')
  @Permissions(PERMISSIONS.FACTURACION_READ)
  findGastos(@Query() query: QueryPeriodoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.inicioService.findGastos(query.periodo, new Types.ObjectId(user.estudioId));
  }

  @Post('gastos')
  @Permissions(PERMISSIONS.FACTURACION_WRITE)
  createGasto(@Body() dto: CreateGastoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.inicioService.createGasto(dto, new Types.ObjectId(user.estudioId));
  }

  @Post('gastos/copiar-mes-anterior')
  @Permissions(PERMISSIONS.FACTURACION_WRITE)
  copiarGastos(@Body() dto: QueryPeriodoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.inicioService.copiarGastosMesAnterior(dto.periodo, new Types.ObjectId(user.estudioId));
  }

  @Patch('gastos/:id')
  @Permissions(PERMISSIONS.FACTURACION_WRITE)
  updateGasto(@Param('id') id: string, @Body() dto: UpdateGastoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.inicioService.updateGasto(id, dto, new Types.ObjectId(user.estudioId));
  }

  @Delete('gastos/:id')
  @Permissions(PERMISSIONS.FACTURACION_WRITE)
  deleteGasto(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.inicioService.deleteGasto(id, new Types.ObjectId(user.estudioId));
  }

  @Get('importes-manuales')
  @Permissions(PERMISSIONS.FACTURACION_READ)
  findImportes(@CurrentUser() user: AuthenticatedUser) {
    return this.inicioService.findImportesManuales(new Types.ObjectId(user.estudioId));
  }

  @Put('importes-manuales/:periodo')
  @Permissions(PERMISSIONS.FACTURACION_WRITE)
  upsertImporte(
    @Param('periodo') periodo: string,
    @Body() dto: UpsertImporteManualDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inicioService.upsertImporteManual(periodo, dto, new Types.ObjectId(user.estudioId));
  }

  @Get('reuniones')
  @Permissions(PERMISSIONS.CLIENTES_READ)
  findReuniones(@Query() query: QueryReunionesDto, @CurrentUser() user: AuthenticatedUser) {
    return this.inicioService.findReuniones(
      new Date(query.desde),
      new Date(query.hasta),
      new Types.ObjectId(user.estudioId),
      new Types.ObjectId(user.userId),
    );
  }

  @Get('reuniones/papelera')
  @Permissions(PERMISSIONS.CLIENTES_READ)
  findReunionesPapelera(@CurrentUser() user: AuthenticatedUser) {
    return this.inicioService.findReunionesPapelera(
      new Types.ObjectId(user.estudioId),
      new Types.ObjectId(user.userId),
    );
  }

  /** Personal para "Miembros" de una reunión — solo pide `clientes.read`, no `users.read`. */
  @Get('reuniones/miembros')
  @Permissions(PERMISSIONS.CLIENTES_READ)
  findMiembrosReunion() {
    return this.inicioService.findMiembrosReunion();
  }

  @Post('reuniones')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  createReunion(@Body() dto: CreateReunionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.inicioService.createReunion(
      dto,
      new Types.ObjectId(user.estudioId),
      new Types.ObjectId(user.userId),
    );
  }

  @Patch('reuniones/:id')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  updateReunion(@Param('id') id: string, @Body() dto: UpdateReunionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.inicioService.updateReunion(id, dto, new Types.ObjectId(user.estudioId), user.userId);
  }

  @Delete('reuniones/:id')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  deleteReunion(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.inicioService.deleteReunion(id, new Types.ObjectId(user.estudioId), user.userId);
  }
}
