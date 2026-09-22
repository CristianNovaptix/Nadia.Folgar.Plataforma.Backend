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
import { ExtractosIaService } from './extractos-ia.service';
import { CreateExtractoDto } from './dto/create-extracto.dto';
import { UpdateMovimientosDto } from './dto/update-movimientos.dto';
import { UpdateExtractoDto } from './dto/update-extracto.dto';
import { QueryExtractoDto } from './dto/query-extracto.dto';
import { AnalizarExtractoDto } from './dto/analizar-extracto.dto';

@ApiTags('extractos-ia')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('extractos-ia')
export class ExtractosIaController {
  constructor(private readonly extractosIaService: ExtractosIaService) {}

  /** Crea el extracto y encola su procesamiento asíncrono contra el puerto de IA (ver `ExtractosIaProcessor`). */
  @Post()
  @Permissions(PERMISSIONS.EXTRACTOS_WRITE)
  cargar(@Body() dto: CreateExtractoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.extractosIaService.cargarExtracto(
      dto,
      new Types.ObjectId(user.estudioId),
      new Types.ObjectId(user.userId),
    );
  }

  /**
   * Análisis previo (sin persistir nada): detecta CUIT/período por regex
   * para que el Frontend pueda sugerir cliente y período antes de que el
   * contador tenga que elegirlos a mano. Mismo permiso que `cargar` — es
   * parte del mismo flujo de subida.
   */
  @Post('analizar')
  @Permissions(PERMISSIONS.EXTRACTOS_WRITE)
  analizar(@Body() dto: AnalizarExtractoDto) {
    return this.extractosIaService.analizarEncabezado(dto);
  }

  @Get()
  @Permissions(PERMISSIONS.EXTRACTOS_READ)
  findAll(@Query() query: QueryExtractoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.extractosIaService.findAll(query, new Types.ObjectId(user.estudioId));
  }

  @Get(':id')
  @Permissions(PERMISSIONS.EXTRACTOS_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.extractosIaService.findOne(id, new Types.ObjectId(user.estudioId));
  }

  /** PDF original del extracto, pedido aparte (no viaja en `findOne`) — ver nota de alcance en el schema. */
  @Get(':id/archivo')
  @Permissions(PERMISSIONS.EXTRACTOS_READ)
  obtenerArchivo(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.extractosIaService.obtenerArchivo(id, new Types.ObjectId(user.estudioId));
  }

  /** Edición manual de los movimientos extraídos antes de confirmarlos (checklist FOLGAR-009). */
  @Patch(':id/movimientos')
  @Permissions(PERMISSIONS.EXTRACTOS_WRITE)
  actualizarMovimientos(
    @Param('id') id: string,
    @Body() dto: UpdateMovimientosDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.extractosIaService.actualizarMovimientos(
      id,
      dto.movimientos,
      new Types.ObjectId(user.estudioId),
    );
  }

  /** Corrige cliente y/o cuenta bancaria de un extracto ya cargado, sin reprocesar el PDF. */
  @Patch(':id')
  @Permissions(PERMISSIONS.EXTRACTOS_WRITE)
  actualizarDatos(
    @Param('id') id: string,
    @Body() dto: UpdateExtractoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.extractosIaService.actualizarDatos(id, dto, new Types.ObjectId(user.estudioId));
  }

  @Delete(':id')
  @Permissions(PERMISSIONS.EXTRACTOS_WRITE)
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.extractosIaService.eliminar(id, new Types.ObjectId(user.estudioId));
  }
}
