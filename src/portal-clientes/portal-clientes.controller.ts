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
import { PortalClientesService } from './portal-clientes.service';
import { CreateDocumentoDto } from './dto/create-documento.dto';
import { QueryDocumentoDto } from './dto/query-documento.dto';
import { CreateComunicadoDto } from './dto/create-comunicado.dto';
import { UpdateComunicadoDto } from './dto/update-comunicado.dto';
import { QueryComunicadoDto } from './dto/query-comunicado.dto';

/**
 * El rol 'cliente' tiene `PORTAL_DOCUMENTOS_READ` por defecto (ver
 * `DEFAULT_ROLE_PERMISSIONS` en `common/constants/permissions.ts`), así que
 * pasa el `PermissionsGuard` exactamente igual que admin/contador. La
 * diferencia de QUÉ ve cada uno no es responsabilidad de este controller ni
 * del guard — es la lógica de scoping de `PortalClientesService`
 * (`findDocumentosParaUsuario` / `findComunicadosParaUsuario`), que es la
 * garantía de seguridad real de este módulo.
 */
@ApiTags('portal-clientes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('portal-clientes')
export class PortalClientesController {
  constructor(private readonly portalClientesService: PortalClientesService) {}

  // ── Documentos ────────────────────────────────────────────────────────

  @Get('documentos')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_READ)
  findAllDocumentos(@Query() query: QueryDocumentoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.portalClientesService.findDocumentosParaUsuario(query, user);
  }

  @Post('documentos')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_WRITE)
  createDocumento(@Body() dto: CreateDocumentoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.portalClientesService.createDocumento(dto, new Types.ObjectId(user.estudioId));
  }

  @Delete('documentos/:id')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_WRITE)
  removeDocumento(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.portalClientesService.removeDocumento(id, new Types.ObjectId(user.estudioId), user.userId);
  }

  // ── Comunicados ───────────────────────────────────────────────────────

  @Get('comunicados')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_READ)
  findAllComunicados(@Query() query: QueryComunicadoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.portalClientesService.findComunicadosParaUsuario(query, user);
  }

  @Post('comunicados')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_WRITE)
  createComunicado(@Body() dto: CreateComunicadoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.portalClientesService.createComunicado(dto, new Types.ObjectId(user.estudioId));
  }

  @Patch('comunicados/:id')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_WRITE)
  updateComunicado(
    @Param('id') id: string,
    @Body() dto: UpdateComunicadoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.portalClientesService.updateComunicado(id, dto, new Types.ObjectId(user.estudioId));
  }

  @Delete('comunicados/:id')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_WRITE)
  removeComunicado(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.portalClientesService.removeComunicado(id, new Types.ObjectId(user.estudioId), user.userId);
  }
}
