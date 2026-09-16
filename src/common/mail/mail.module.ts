import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * `@Global()` — cualquier módulo puede inyectar `MailService` sin declarar
 * `MailModule` en sus propios `imports` (mismo criterio que otros servicios
 * transversales del proyecto), con tal de que `AppModule` lo importe una vez.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
