import {
  BadRequestException,
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
import { UpdateDocumentoDto } from './dto/update-documento.dto';
import { CarpetasDocumentosService } from './carpetas-documentos.service';
import {
  CreateCarpetaDocumentoDto,
  MoverDocumentoDto,
  QueryCarpetaDocumentoDto,
  UpdateCarpetaDocumentoDto,
} from './dto/carpeta-documento.dto';
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
  constructor(
    private readonly portalClientesService: PortalClientesService,
    private readonly carpetasService: CarpetasDocumentosService,
  ) {}

  // ── Documentos ────────────────────────────────────────────────────────

  @Get('documentos')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_READ)
  findAllDocumentos(@Query() query: QueryDocumentoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.portalClientesService.findDocumentosParaUsuario(query, user);
  }

  @Get('documentos/:id')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_READ)
  findOneDocumento(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.portalClientesService.findDocumentoParaUsuario(id, user);
  }

  @Post('documentos')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_WRITE)
  async createDocumento(@Body() dto: CreateDocumentoDto, @CurrentUser() user: AuthenticatedUser) {
    const estudioId = new Types.ObjectId(user.estudioId);
    // La carpeta tiene que ser del mismo cliente (sin carpeta = raíz).
    await this.carpetasService.validarCarpeta(
      dto.carpetaId,
      new Types.ObjectId(dto.clienteId),
      estudioId,
    );
    return this.portalClientesService.createDocumento(dto, estudioId);
  }

  /** Mover un documento a otra carpeta (`carpetaId: null` = raíz). */
  @Patch('documentos/:id/carpeta')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_WRITE)
  moverDocumento(
    @Param('id') id: string,
    @Body() dto: MoverDocumentoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.carpetasService.moverDocumento(
      id,
      dto.carpetaId,
      new Types.ObjectId(user.estudioId),
    );
  }

  // ── Carpetas de documentos ────────────────────────────────────────────

  @Get('carpetas')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_READ)
  findCarpetas(@Query() query: QueryCarpetaDocumentoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.carpetasService.listar(query, user);
  }

  @Post('carpetas')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_WRITE)
  createCarpeta(@Body() dto: CreateCarpetaDocumentoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.carpetasService.crear(dto, new Types.ObjectId(user.estudioId));
  }

  @Patch('carpetas/:id')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_WRITE)
  updateCarpeta(
    @Param('id') id: string,
    @Body() dto: UpdateCarpetaDocumentoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.carpetasService.actualizar(id, dto, new Types.ObjectId(user.estudioId));
  }

  @Delete('carpetas/:id')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_WRITE)
  removeCarpeta(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.carpetasService.eliminar(id, new Types.ObjectId(user.estudioId));
  }

  @Patch('documentos/:id')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_WRITE)
  updateDocumento(
    @Param('id') id: string,
    @Body() dto: UpdateDocumentoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.portalClientesService.updateDocumento(
      id,
      dto,
      new Types.ObjectId(user.estudioId),
      user.userId,
    );
  }

  /** Vaciar la papelera de documentos de un cliente, de una sola vez. Va antes de `documentos/:id`. */
  @Delete('documentos/papelera')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_WRITE)
  vaciarPapelera(@Query() query: QueryCarpetaDocumentoDto, @CurrentUser() user: AuthenticatedUser) {
    if (!query.clienteId) throw new BadRequestException('Falta el cliente');
    return this.portalClientesService.vaciarPapelera(
      query.clienteId,
      new Types.ObjectId(user.estudioId),
      user.userId,
    );
  }

  @Delete('documentos/:id')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_WRITE)
  removeDocumento(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.portalClientesService.removeDocumento(
      id,
      new Types.ObjectId(user.estudioId),
      user.userId,
    );
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
    return this.portalClientesService.removeComunicado(
      id,
      new Types.ObjectId(user.estudioId),
      user.userId,
    );
  }
}
