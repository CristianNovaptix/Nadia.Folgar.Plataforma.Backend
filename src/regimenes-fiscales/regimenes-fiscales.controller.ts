import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/permissions';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { RegimenesFiscalesService } from './regimenes-fiscales.service';
import { UpdateRegimenFiscalDto } from './dto/update-regimen-fiscal.dto';

/** Vive en Configuración (Frontend), así que usa los mismos permisos que esa sección. */
@ApiTags('regimenes-fiscales')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('regimenes-fiscales')
export class RegimenesFiscalesController {
  constructor(private readonly service: RegimenesFiscalesService) {}

  @Get()
  @Permissions(PERMISSIONS.CONFIGURACION_READ)
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.service.findAll(new Types.ObjectId(user.estudioId));
  }

  @Put(':regimen')
  @Permissions(PERMISSIONS.CONFIGURACION_WRITE)
  update(
    @Param('regimen') regimen: string,
    @Body() dto: UpdateRegimenFiscalDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.update(regimen, dto, new Types.ObjectId(user.estudioId));
  }
}
