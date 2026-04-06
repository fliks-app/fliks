import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { LogBufferService } from './modules/scheduler/log-buffer.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    forceCloseConnections: true,
  });
  const logBuffer = app.get(LogBufferService);
  app.useLogger(logBuffer);
  app.enableShutdownHooks();

  const ds = app.get(DataSource);
  await ds.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');

  const envOrigins =
    process.env.CORS_ORIGIN?.split(',')
      .map((o) => o.trim())
      .filter(Boolean) ?? [];
  /** Toujours autorisées : WebView Capacitor (origine ≠ URL de l’API LAN). */
  const nativeAppOrigins = [
    'https://localhost',
    'capacitor://localhost',
    'http://localhost',
  ];
  const defaultWebOrigins = ['http://localhost:4200', 'http://localhost:4500'];
  const corsOrigins = [
    ...new Set([
      ...(envOrigins.length > 0 ? envOrigins : defaultWebOrigins),
      ...nativeAppOrigins,
    ]),
  ];
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
}
bootstrap();
