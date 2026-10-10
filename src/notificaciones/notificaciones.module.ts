import { ClientesModule } from '../clientes/clientes.module';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Cliente, ClienteSchema } from '../clientes/schemas/cliente.schema';
import { Vencimiento, VencimientoSchema } from './schemas/vencimiento.schema';
import { ReglaNotificacion, ReglaNotificacionSchema } from './schemas/regla-notificacion.schema';
import {
  NotificacionEnviada,
  NotificacionEnviadaSchema,
} from './schemas/notificacion-enviada.schema';
import { NotificacionesService } from './notificaciones.service';
import { NotificacionesController } from './notificaciones.controller';
import { MESSAGING_PROVIDER } from './ports/messaging-provider.port';
import { EmailAdapter } from './adapters/email.adapter';
import { WhatsappStubAdapter } from './adapters/whatsapp-stub.adapter';

/**
 * NOTA: este módulo todavía NO se importa en app.module.ts a propósito —
 * esa integración queda a cargo de otro cambio en paralelo sobre ese mismo
 * archivo, para evitar pisarlo. Ver FOLGAR-033 a FOLGAR-039.
 *
 * `EmailAdapter` es el adapter por defecto del puerto `MessagingProvider`
 * (ambos adapters son stubs por ahora — ver sus comentarios). Cuando se
 * confirme el proveedor real de mail y/o la integración de WhatsApp
 * (FOLGAR-036), este `useClass` se reemplaza o se resuelve dinámicamente
 * por canal, sin tocar `NotificacionesService`.
 */
@Module({
  imports: [
    ClientesModule,
    MongooseModule.forFeature([
      { name: Vencimiento.name, schema: VencimientoSchema },
      { name: ReglaNotificacion.name, schema: ReglaNotificacionSchema },
      { name: NotificacionEnviada.name, schema: NotificacionEnviadaSchema },
      { name: Cliente.name, schema: ClienteSchema },
    ]),
  ],
  controllers: [NotificacionesController],
  providers: [
    NotificacionesService,
    WhatsappStubAdapter,
    { provide: MESSAGING_PROVIDER, useClass: EmailAdapter },
  ],
  exports: [NotificacionesService],
})
export class NotificacionesModule {}
