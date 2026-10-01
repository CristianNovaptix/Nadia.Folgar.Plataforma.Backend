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
import { ReglasClasificacionService } from './reglas-clasificacion.service';
import { CreateReglaClasificacionDto } from './dto/create-regla-clasificacion.dto';
import { UpdateReglaClasificacionDto } from './dto/update-regla-clasificacion.dto';
import { QueryReglaClasificacionDto } from './dto/query-regla-clasificacion.dto';

@ApiTags('reglas-clasificacion')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('reglas-clasificacion')
export class ReglasClasificacionController {
  constructor(private readonly reglasClasificacionService: ReglasClasificacionService) {}

  @Get()
  @Permissions(PERMISSIONS.EXTRACTOS_REGLAS_READ)
  findAll(@Query() query: QueryReglaClasificacionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reglasClasificacionService.findAll(query, new Types.ObjectId(user.estudioId));
  }

  @Post()
  @Permissions(PERMISSIONS.EXTRACTOS_REGLAS_WRITE)
  create(@Body() dto: CreateReglaClasificacionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reglasClasificacionService.create(
      dto,
      new Types.ObjectId(user.estudioId),
      new Types.ObjectId(user.userId),
    );
  }

  @Patch(':id')
  @Permissions(PERMISSIONS.EXTRACTOS_REGLAS_WRITE)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateReglaClasificacionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reglasClasificacionService.update(id, dto, new Types.ObjectId(user.estudioId));
  }

  /** Borra una regla — lo usa "Deshacer" justo después de guardar una regla desde un extracto. */
  @Delete(':id')
  @Permissions(PERMISSIONS.EXTRACTOS_REGLAS_WRITE)
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reglasClasificacionService.remove(id, new Types.ObjectId(user.estudioId));
  }
}
