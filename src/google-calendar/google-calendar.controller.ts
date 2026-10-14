import { Controller, Delete, Get, Query, Redirect, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { GoogleCalendarService } from './google-calendar.service';

/** "Sincronizar cuenta" de la Agenda del estudio: cada usuario conecta su propio Google Calendar. */
@ApiTags('google-calendar')
@Controller('google-calendar')
export class GoogleCalendarController {
  constructor(private readonly googleCalendar: GoogleCalendarService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('estado')
  estado(@CurrentUser() user: AuthenticatedUser) {
    return this.googleCalendar.estado(user.userId);
  }

  /** Devuelve la URL de Google a la que el Frontend redirige (no redirige acá: hace falta el token). */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('conectar')
  conectar(@CurrentUser() user: AuthenticatedUser) {
    return { url: this.googleCalendar.urlConexion(user.userId, user.estudioId) };
  }

  /** Vuelta de Google: público, el usuario sale del `state` firmado. */
  @Get('callback')
  @Redirect('', 302)
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    return { url: await this.googleCalendar.completarConexion(code, state, error) };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Delete()
  async desconectar(@CurrentUser() user: AuthenticatedUser) {
    await this.googleCalendar.desconectar(user.userId);
    return { ok: true };
  }
}
