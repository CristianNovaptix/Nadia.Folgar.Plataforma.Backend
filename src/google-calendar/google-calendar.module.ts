import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { SecretCipherService } from '../common/crypto/secret-cipher.service';
import { Reunion, ReunionSchema } from '../inicio/schemas/reunion.schema';
import { GoogleCalendarCuenta, GoogleCalendarCuentaSchema } from './schemas/google-calendar-cuenta.schema';
import { GoogleCalendarService } from './google-calendar.service';
import { GoogleCalendarController } from './google-calendar.controller';

@Module({
  imports: [
    JwtModule.register({}),
    MongooseModule.forFeature([
      { name: GoogleCalendarCuenta.name, schema: GoogleCalendarCuentaSchema },
      { name: Reunion.name, schema: ReunionSchema },
    ]),
  ],
  controllers: [GoogleCalendarController],
  providers: [GoogleCalendarService, SecretCipherService],
  exports: [GoogleCalendarService],
})
export class GoogleCalendarModule {}
