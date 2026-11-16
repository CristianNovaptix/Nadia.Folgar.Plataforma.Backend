import { ClientesModule } from '../clientes/clientes.module';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Cliente, ClienteSchema } from '../clientes/schemas/cliente.schema';
import { MESSAGING_PROVIDER } from '../notificaciones/ports/messaging-provider.port';
import { EmailAdapter } from '../notificaciones/adapters/email.adapter';
import { Documento, DocumentoSchema } from './schemas/documento.schema';
import { Comunicado, ComunicadoSchema } from './schemas/comunicado.schema';
import { PortalClientesService } from './portal-clientes.service';
import { CarpetasDocumentosService } from './carpetas-documentos.service';
import { CarpetaDocumento, CarpetaDocumentoSchema } from './schemas/carpeta-documento.schema';
import { PortalClientesController } from './portal-clientes.controller';
import { ResumenClienteService } from './resumen-cliente.service';
import {
  ArcaSincronizacion,
  ArcaSincronizacionSchema,
} from '../arca-sync/schemas/arca-sincronizacion.schema';
import { Factura, FacturaSchema } from '../facturacion-electronica/schemas/factura.schema';
import {
  TareaPresentacion,
  TareaPresentacionSchema,
} from '../iva-tareas/schemas/tarea-presentacion.schema';
import { Vencimiento, VencimientoSchema } from '../notificaciones/schemas/vencimiento.schema';
import { Reunion, ReunionSchema } from '../inicio/schemas/reunion.schema';
import { PanelClienteMes, PanelClienteMesSchema } from './schemas/panel-cliente-mes.schema';
import { PanelClienteService } from './panel-cliente.service';
import { NotificacionesClienteService } from './notificaciones-cliente.service';
import { ComunicadoEstado, ComunicadoEstadoSchema } from './schemas/comunicado-estado.schema';
import {
  DeudaHonorario,
  DeudaHonorarioSchema,
} from '../finanzas/schemas/deuda-honorario.schema';

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
      { name: CarpetaDocumento.name, schema: CarpetaDocumentoSchema },
      { name: ArcaSincronizacion.name, schema: ArcaSincronizacionSchema },
      { name: Factura.name, schema: FacturaSchema },
      { name: TareaPresentacion.name, schema: TareaPresentacionSchema },
      { name: Vencimiento.name, schema: VencimientoSchema },
      { name: Reunion.name, schema: ReunionSchema },
      { name: PanelClienteMes.name, schema: PanelClienteMesSchema },
      { name: ComunicadoEstado.name, schema: ComunicadoEstadoSchema },
      // Deuda mensual de honorarios (dueño real: `FinanzasModule`) para el Inicio del cliente.
      { name: DeudaHonorario.name, schema: DeudaHonorarioSchema },
    ]),
  ],
  controllers: [PortalClientesController],
  providers: [
    PortalClientesService,
    CarpetasDocumentosService,
    ResumenClienteService,
    NotificacionesClienteService,
    PanelClienteService,
    { provide: MESSAGING_PROVIDER, useClass: EmailAdapter },
  ],
  exports: [PortalClientesService],
})
export class PortalClientesModule {}
