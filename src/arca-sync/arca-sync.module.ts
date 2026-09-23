import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Cliente, ClienteSchema } from '../clientes/schemas/cliente.schema';
import { SecretCipherService } from '../common/crypto/secret-cipher.service';
import { ArcaSincronizacion, ArcaSincronizacionSchema } from './schemas/arca-sincronizacion.schema';
import { ARCA_PORTAL_PORT } from './ports/arca-portal.port';
import { ArcaPlaywrightAdapter } from './adapters/arca-playwright.adapter';
import { ArcaSyncService } from './arca-sync.service';
import { ArcaSyncController } from './arca-sync.controller';

/**
 * Sincronización automática con ARCA usando la clave fiscal de cada cliente
 * (`Cliente.credencialesArca`). Alimenta la pestaña ARCA de "Notificaciones"
 * del Frontend. `SecretCipherService` se registra acá por el mismo criterio
 * que en `ClientesModule`: no tiene estado.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Cliente.name, schema: ClienteSchema },
      { name: ArcaSincronizacion.name, schema: ArcaSincronizacionSchema },
    ]),
  ],
  controllers: [ArcaSyncController],
  providers: [
    ArcaSyncService,
    SecretCipherService,
    { provide: ARCA_PORTAL_PORT, useClass: ArcaPlaywrightAdapter },
  ],
})
export class ArcaSyncModule {}
