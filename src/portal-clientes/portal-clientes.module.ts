import { ClientesModule } from '../clientes/clientes.module';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Cliente, ClienteSchema } from '../clientes/schemas/cliente.schema';
import { MESSAGING_PROVIDER } from '../notificaciones/ports/messaging-provider.port';
import { EmailAdapter } from '../notificaciones/adapters/email.adapter';
import { Documento, DocumentoSchema } from './schemas/documento.schema';
import { Comunicado, ComunicadoSchema } from './schemas/comunicado.schema';
import { PortalClientesService } from './portal-clientes.service';
import { PortalClientesController } from './portal-clientes.controller';

/**
 * NOTA: igual que `NotificacionesModule`, este módulo todavía NO se importa
 * en `app.module.ts` a propósito — esa integración queda a cargo de otro
 * cambio en paralelo sobre ese mismo archivo, para evitar pisarlo. Ver
 * FOLGAR-023 a FOLGAR-027.
 *
 * Reutiliza el puerto `MessagingProvider` y el adapter stub `EmailAdapter`
 * de `notificaciones/` (mismo contrato, no se duplica ni se modifica ese
 * código) para avisarle al cliente cuando hay un documento o comunicado
 * nuevo dirigido a él (FOLGAR-026). Se registra el `useClass` acá mismo, en
 * vez de importar `NotificacionesModule`, porque ese módulo hoy no exporta
 * el token `MESSAGING_PROVIDER` — si en el futuro empieza a exportarlo, este
 * provider puede reemplazarse por `imports: [NotificacionesModule]` sin
 * tocar el resto de este módulo.
 */
@Module({
  imports: [
    ClientesModule,
    MongooseModule.forFeature([
      { name: Documento.name, schema: DocumentoSchema },
      { name: Comunicado.name, schema: ComunicadoSchema },
      { name: Cliente.name, schema: ClienteSchema },
    ]),
  ],
  controllers: [PortalClientesController],
  providers: [PortalClientesService, { provide: MESSAGING_PROVIDER, useClass: EmailAdapter }],
  exports: [PortalClientesService],
})
export class PortalClientesModule {}
