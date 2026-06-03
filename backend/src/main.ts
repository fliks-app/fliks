// Must be set before any I/O — libuv initializes the pool on first use.
process.env.UV_THREADPOOL_SIZE = '16';

import { NestFactory, Reflector } from '@nestjs/core';
import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common';
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

  // Trust reverse proxy headers (X-Forwarded-For) so req.ip is the real client IP
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', true);

  // CDNs (Cloudflare etc.) cache 4xx responses by default — disastrous
  // for live transcoding where a transient 404 (segment requested
  // before ffmpeg wrote it) gets pinned under the URL and every retry
  // sees the same 404 even after the file exists. Intercept writeHead
  // to force `Cache-Control: no-store` on every error response before
  // it leaves the process. Successful responses keep whatever headers
  // their controller set.
  expressApp.use(
    (
      _req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      const origWriteHead = res.writeHead.bind(res);
      res.writeHead = function (statusCode: number, ...args: unknown[]) {
        if (statusCode >= 400) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        }
        return (origWriteHead as (s: number, ...a: unknown[]) => typeof res)(
          statusCode,
          ...args,
        );
      } as typeof res.writeHead;
      next();
    },
  );

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Honor class-transformer decorators (@Exclude on credential columns) on
  // every entity instance a controller returns. Plain-object responses pass
  // through unchanged; @Res()/SSE handlers bypass interceptors entirely.
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  const port = Number(process.env.PORT) || 4848;
  await app.listen(port);
}
bootstrap();
