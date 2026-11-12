import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
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
import { ClientesService } from '../clientes/clientes.service';
import { NotificacionesClienteService } from './notificaciones-cliente.service';
import { ActualizarNotificacionClienteDto } from './dto/notificacion-cliente.dto';
import { CreateDocumentoDto } from './dto/create-documento.dto';
import { QueryDocumentoDto } from './dto/query-documento.dto';
import { UpdateDocumentoDto } from './dto/update-documento.dto';
import { CarpetasDocumentosService } from './carpetas-documentos.service';
import { ResumenClienteService } from './resumen-cliente.service';
import { PanelClienteService } from './panel-cliente.service';
import { GuardarPanelClienteDto } from './dto/panel-cliente.dto';
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
    private readonly resumenClienteService: ResumenClienteService,
    private readonly panelClienteService: PanelClienteService,
    private readonly clientesService: ClientesService,
    private readonly notificacionesClienteService: NotificacionesClienteService,
  ) {}

  /** Inicio del rol cliente: datos de ARCA y honorarios del propio cliente del token. */
  @Get('mi-resumen')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_READ)
  miResumen(@CurrentUser() user: AuthenticatedUser) {
    return this.resumenClienteService.resumen(user);
  }

  /**
   * Pestaña "Credenciales" de "Mi portal": usuario y vista previa de la contraseña de
   * ARCA/ARBA/AGIP que el estudio cargó para el propio cliente del token (nunca otro).
   */
  @Get('mis-credenciales')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_READ)
  async misCredenciales(@CurrentUser() user: AuthenticatedUser) {
    const cliente = await this.clientesService.findOne(
      this.clienteDelPortal(user),
      new Types.ObjectId(user.estudioId),
    );
    const resumen = (valor: unknown) => {
      const c = (valor ?? {}) as { usuario?: string; passwordPreview?: string };
      return { usuario: c.usuario, passwordPreview: c.passwordPreview };
    };
    return {
      arca: resumen(cliente.credencialesArca),
      arba: resumen(cliente.credencialesArba),
      agip: resumen(cliente.credencialesAgip),
    };
  }

  /** "Ver contraseña" de su propia credencial — mismo descifrado que usa el estudio. */
  @Get('mis-credenciales/:organismo/revelar')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_READ)
  revelarMiCredencial(@Param('organismo') organismo: string, @CurrentUser() user: AuthenticatedUser) {
    if (organismo !== 'arca' && organismo !== 'arba' && organismo !== 'agip') {
      throw new BadRequestException('Organismo inválido');
    }
    return this.clientesService.revelarCredencial(
      this.clienteDelPortal(user),
      organismo,
      new Types.ObjectId(user.estudioId),
    );
  }

  // ── Campanita del portal (comunicados con estado por usuario) ─────────

  @Get('mis-notificaciones')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_READ)
  misNotificaciones(@CurrentUser() user: AuthenticatedUser) {
    return this.notificacionesClienteService.listar(user);
  }

  @Post('mis-notificaciones/marcar-todas-leidas')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_READ)
  marcarNotificacionesLeidas(@CurrentUser() user: AuthenticatedUser) {
    return this.notificacionesClienteService.marcarTodasLeidas(user);
  }

  @Patch('mis-notificaciones/:comunicadoId')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_READ)
  actualizarNotificacion(
    @Param('comunicadoId') comunicadoId: string,
    @Body() dto: ActualizarNotificacionClienteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notificacionesClienteService.actualizar(comunicadoId, dto, user);
  }

  /** "Eliminar definitivamente" de la papelera: solo la saca de su campanita. */
  @Delete('mis-notificaciones/:comunicadoId')
  @Permissions(PERMISSIONS.PORTAL_DOCUMENTOS_READ)
  eliminarNotificacion(
    @Param('comunicadoId') comunicadoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notificacionesClienteService.actualizar(comunicadoId, { eliminada: true }, user);
  }

  private clienteDelPortal(user: AuthenticatedUser): string {
    if (!user.roles.includes('cliente') || !user.clienteId) {
      throw new ForbiddenException('Solo disponible para usuarios del portal de clientes');
    }
    return user.clienteId;
  }

  /** "Panel del cliente" (carpeta del cliente): lo cargado a mano por mes para su Inicio. */
  @Get('panel/:clienteId')
  @Permissions(PERMISSIONS.CLIENTES_READ)
  listarPanel(@Param('clienteId') clienteId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.panelClienteService.listar(clienteId, new Types.ObjectId(user.estudioId));
  }

  @Put('panel/:clienteId/:periodo')
  @Permissions(PERMISSIONS.CLIENTES_WRITE)
  guardarPanel(
    @Param('clienteId') clienteId: string,
    @Param('periodo') periodo: string,
    @Body() dto: GuardarPanelClienteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.panelClienteService.guardar(
      clienteId,
      periodo,
      dto,
      new Types.ObjectId(user.estudioId),
    );
  }

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
