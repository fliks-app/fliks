"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const app_module_1 = require("./app.module");
const log_buffer_service_1 = require("./modules/scheduler/log-buffer.service");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    const logBuffer = app.get(log_buffer_service_1.LogBufferService);
    app.useLogger(logBuffer);
    app.enableShutdownHooks();
    const ds = app.get(typeorm_1.DataSource);
    await ds.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    const parsed = process.env.CORS_ORIGIN?.split(',')
        .map((o) => o.trim())
        .filter(Boolean);
    const corsOrigins = parsed && parsed.length > 0
        ? parsed
        : ['http://localhost:4200', 'http://localhost:4500'];
    app.enableCors({
        origin: corsOrigins,
        credentials: true,
    });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new common_1.ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
    }));
    const port = Number(process.env.PORT) || 3000;
    await app.listen(port);
}
bootstrap();
//# sourceMappingURL=main.js.map