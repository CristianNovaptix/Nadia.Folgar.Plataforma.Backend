import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Cliente, ClienteSchema } from './schemas/cliente.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../roles/schemas/role.schema';
import { IntegracionIa, IntegracionIaSchema } from '../configuracion/schemas/integracion-ia.schema';
import { ClientesService } from './clientes.service';
import { ClientesController } from './clientes.controller';
import { SecretCipherService } from '../common/crypto/secret-cipher.service';
import { ClienteHistorialService } from './cliente-historial.service';
import { ClienteEvento, ClienteEventoSchema } from './schemas/cliente-evento.schema';
import {
  ExtractoBancario,
  ExtractoBancarioSchema,
} from '../extractos-ia/schemas/extracto-bancario.schema';
import { Reunion, ReunionSchema } from '../inicio/schemas/reunion.schema';
import { Documento, DocumentoSchema } from '../portal-clientes/schemas/documento.schema';
import { Comunicado, ComunicadoSchema } from '../portal-clientes/schemas/comunicado.schema';
import { Factura, FacturaSchema } from '../facturacion-electronica/schemas/factura.schema';
import { Vencimiento, VencimientoSchema } from '../notificaciones/schemas/vencimiento.schema';
import {
  NotificacionEnviada,
  NotificacionEnviadaSchema,
} from '../notificaciones/schemas/notificacion-enviada.schema';
import {
  TareaPresentacion,
  TareaPresentacionSchema,
} from '../iva-tareas/schemas/tarea-presentacion.schema';

/**
 * Registra también el schema de `IntegracionIa` (dueño real: `ConfiguracionModule`)
 * para que `ClientesService` pueda validar `motorIaPreferido` contra las
 * integraciones conectadas sin importar `ConfiguracionModule` — que a su vez
 * importa `ClientesModule` para `AiProviderResolverService`. Registrar el
 * mismo schema desde dos módulos con `MongooseModule.forFeature` es sano en
 * Mongoose (misma colección, sin acoplar los módulos entre sí); importar
 * `ConfiguracionModule` acá sí generaría una dependencia circular real.
 * Mismo criterio para `Role`: `ClientesService.crearUsuarioPortal` necesita
 * el rol de sistema "cliente" para dar de alta el usuario de portal, sin
 * depender de `RolesModule`/`UsersModule` completos.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Cliente.name, schema: ClienteSchema },
      // Para calcular `responsablesEfectivos` (asignación real + el/los
      // titular/es del estudio marcados con `User.esTitular`) en
      // `ClientesService` — ver el comentario en `cliente.schema.ts`. También
      // usado por `crearUsuarioPortal` para dar de alta el usuario de portal.
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      { name: IntegracionIa.name, schema: IntegracionIaSchema },
      // Historial del cliente ("Ver historial"): lee los registros de cada
      // módulo que tienen `clienteId` — ver `ClienteHistorialService`.
      { name: ClienteEvento.name, schema: ClienteEventoSchema },
      { name: ExtractoBancario.name, schema: ExtractoBancarioSchema },
      { name: Reunion.name, schema: ReunionSchema },
      { name: Documento.name, schema: DocumentoSchema },
      { name: Comunicado.name, schema: ComunicadoSchema },
      { name: Factura.name, schema: FacturaSchema },
      { name: Vencimiento.name, schema: VencimientoSchema },
      { name: NotificacionEnviada.name, schema: NotificacionEnviadaSchema },
      { name: TareaPresentacion.name, schema: TareaPresentacionSchema },
    ]),
  ],
  controllers: [ClientesController],
  // `SecretCipherService` también se registra acá (no solo en
  // `ConfiguracionModule`), mismo criterio que los schemas de arriba: es sin
  // estado (solo lee `SECRETS_ENCRYPTION_KEY` del entorno), así que
  // `ClientesService` la usa directo para cifrar las credenciales de
  // ARCA/ARBA/AGIP sin importar `ConfiguracionModule` completo.
  providers: [ClientesService, ClienteHistorialService, SecretCipherService],
  // `ClienteHistorialService` se exporta para que cada módulo registre en el
  // historial cuando se elimina algo de un cliente (reunión, tarea, extracto...).
  exports: [ClientesService, ClienteHistorialService],
})
export class ClientesModule {}
