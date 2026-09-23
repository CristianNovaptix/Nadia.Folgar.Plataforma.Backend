import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.validation';
import { GlobalHttpExceptionFilter } from './common/filters/http-exception.filter';
import { MailModule } from './common/mail/mail.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { RolesModule } from './roles/roles.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ClientesModule } from './clientes/clientes.module';
import { CatedralModule } from './catedral/catedral.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ExtractosIaModule } from './extractos-ia/extractos-ia.module';
import { PlanCuentasModule } from './plan-cuentas/plan-cuentas.module';
import { CuentasBancariasModule } from './cuentas-bancarias/cuentas-bancarias.module';
import { ReglasClasificacionModule } from './reglas-clasificacion/reglas-clasificacion.module';
import { NotificacionesModule } from './notificaciones/notificaciones.module';
import { PortalClientesModule } from './portal-clientes/portal-clientes.module';
import { AlertaPresentacionesModule } from './alerta-presentaciones/alerta-presentaciones.module';
import { IvaTareasModule } from './iva-tareas/iva-tareas.module';
import { FacturacionElectronicaModule } from './facturacion-electronica/facturacion-electronica.module';
import { AsistenteIaModule } from './asistente-ia/asistente-ia.module';
import { ConfiguracionModule } from './configuracion/configuracion.module';
import { HealthModule } from './health/health.module';
import { ArcaSyncModule } from './arca-sync/arca-sync.module';
import { useRedisQueues } from './config/queue-mode';

const httpLogsEnabled = (value?: string): boolean => value === 'true' || value === '1';

const queueImports = useRedisQueues()
  ? [
      BullModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (configService: ConfigService) => ({
          connection: {
            url: configService.get<string>('REDIS_URL'),
            maxRetriesPerRequest: null,
            connectTimeout: 10000,
          },
        }),
      }),
    ]
  : [];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      expandVariables: true,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        pinoHttp: {
          level: configService.get<string>('NODE_ENV') === 'production' ? 'info' : 'debug',
          autoLogging:
            configService.get<string>('NODE_ENV') === 'production' ||
            httpLogsEnabled(configService.get<string>('HTTP_LOGS')),
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-key"]',
            'req.headers["set-cookie"]',
          ],
          transport:
            configService.get<string>('NODE_ENV') === 'production'
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'),
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
      }),
    }),
    ...queueImports,
    // Límite global por IP para toda la API (ver `THROTTLE_LIMIT` en
    // .env.example para el porqué de 300: una sola carga del Dashboard ya
    // dispara ~6-7 GET en paralelo). El login tiene su propio límite aparte,
    // más estricto, vía `@Throttle` en `AuthController.login` — no depende
    // de este default.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => [
        {
          ttl: configService.get<number>('THROTTLE_TTL') ?? 60000,
          limit: configService.get<number>('THROTTLE_LIMIT') ?? 300,
        },
      ],
    }),
    ScheduleModule.forRoot(),
    MailModule,
    TenancyModule,
    RolesModule,
    UsersModule,
    AuthModule,
    ClientesModule,
    CatedralModule,
    RealtimeModule,
    ExtractosIaModule,
    PlanCuentasModule,
    CuentasBancariasModule,
    ReglasClasificacionModule,
    NotificacionesModule,
    PortalClientesModule,
    AlertaPresentacionesModule,
    IvaTareasModule,
    FacturacionElectronicaModule,
    AsistenteIaModule,
    ConfiguracionModule,
    HealthModule,
    ArcaSyncModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalHttpExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
