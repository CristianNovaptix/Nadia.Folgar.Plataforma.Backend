import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/permissions';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { FinanzasService } from './finanzas.service';
import {
  ActualizarDeudaDto,
  AnularPagoDto,
  GenerarDeudasDto,
  GuardarHonorarioDto,
  RegistrarPagoDto,
} from './dto/finanzas.dto';

/**
 * Finanzas: métricas y honorarios. Las rutas sin `@Permissions` las puede
 * usar quien tenga Finanzas completo (`finanzas.read`) o quien solo cobra a
 * sus clientes a cargo (`finanzas.cobros`); el servicio decide qué clientes
 * ve cada uno (`FinanzasService.alcance`).
 */
@ApiTags('finanzas')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('finanzas')
export class FinanzasController {
  constructor(private readonly finanzasService: FinanzasService) {}

  @Get('metricas')
  @Permissions(PERMISSIONS.FINANZAS_READ)
  metricas(@CurrentUser() user: AuthenticatedUser) {
    return this.finanzasService.metricas(user);
  }

  @Get('facturadores')
  facturadores(@CurrentUser() user: AuthenticatedUser) {
    return this.finanzasService.facturadores(user);
  }

  @Get('honorarios')
  listar(@CurrentUser() user: AuthenticatedUser) {
    return this.finanzasService.listar(user);
  }

  @Get('honorarios/:clienteId')
  detalle(@Param('clienteId') clienteId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.finanzasService.detalle(clienteId, user);
  }

  @Put('honorarios/:clienteId')
  @Permissions(PERMISSIONS.FINANZAS_WRITE)
  guardar(
    @Param('clienteId') clienteId: string,
    @Body() dto: GuardarHonorarioDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.finanzasService.guardar(clienteId, dto, user);
  }

  @Post('deudas/generar')
  @Permissions(PERMISSIONS.FINANZAS_WRITE)
  generarDeudas(@Body() dto: GenerarDeudasDto, @CurrentUser() user: AuthenticatedUser) {
    return this.finanzasService.generarDeudasManual(dto.periodo, dto.clienteId, user);
  }

  /** Cambia quién factura o el vencimiento de la deuda de un mes puntual. */
  @Patch('deudas/:deudaId')
  @Permissions(PERMISSIONS.FINANZAS_WRITE)
  actualizarDeuda(
    @Param('deudaId') deudaId: string,
    @Body() dto: ActualizarDeudaDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.finanzasService.actualizarDeuda(deudaId, dto, user);
  }

  @Post('deudas/:deudaId/pagos')
  registrarPago(
    @Param('deudaId') deudaId: string,
    @Body() dto: RegistrarPagoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.finanzasService.registrarPago(deudaId, dto, user);
  }

  @Patch('deudas/:deudaId/pagos/:pagoId/anular')
  @Permissions(PERMISSIONS.FINANZAS_WRITE)
  anularPago(
    @Param('deudaId') deudaId: string,
    @Param('pagoId') pagoId: string,
    @Body() dto: AnularPagoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.finanzasService.anularPago(deudaId, pagoId, dto, user);
  }
}
