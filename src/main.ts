import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module';
import { parseCorsOrigins } from './config/cors-origins';
import { applyDnsFallback } from './config/dns-fallback';

async function bootstrap(): Promise<void> {
  console.log('[bootstrap] Iniciando API Nadia Folgar...');
  applyDnsFallback();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // bodyLimit por encima del default de Fastify (1 MB): portal-clientes
    // (FOLGAR-024) y la foto de "Mi perfil" (users/dto/update-avatar.dto.ts)
    // guardan el archivo como base64 en el body del request mientras no hay
    // storage de objetos real. 16 MB cubre el mayor de los dos topes ya
    // codificado en base64 (~+33%) — `MAX_AVATAR_BYTES` (10 MB → ~13.3 MB en
    // base64) — más margen para el resto del payload JSON.
    new FastifyAdapter({ bodyLimit: 16 * 1024 * 1024 }),
    {
      bufferLogs: true,
    },
  );

  app.useLogger(app.get(Logger));

  const configService = app.get(ConfigService);

  await app.register(helmet, { contentSecurityPolicy: false });

  app.enableCors({
    origin: parseCorsOrigins(
      configService.get<string>('CORS_ORIGIN', 'http://localhost:5173,http://127.0.0.1:5173'),
      configService.get<string>('NODE_ENV', 'development'),
    ),
    // El default de @nestjs/platform-fastify para `methods` es 'GET,HEAD,POST'
    // — sin esto, cualquier PATCH/PUT/DELETE (edición y borrado en toda la
    // app) falla el preflight y nunca llega a pegarle al Backend desde un
    // navegador real, aunque funcione perfecto contra supertest/curl.
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  app.setGlobalPrefix(configService.get<string>('API_PREFIX', 'api/v1'));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Nadia Folgar — API')
    .setDescription('API de la plataforma operativa del Estudio Contable Nadia Folgar')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`[bootstrap] API escuchando en http://localhost:${port}`);
}

bootstrap().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error('[bootstrap] Fallo al iniciar la API:');
  console.error(message);
  process.exit(1);
});
