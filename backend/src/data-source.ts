import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';
import { join } from 'path';

/**
 * Standalone TypeORM DataSource used by the CLI (`migration:generate`,
 * `migration:run`, `migration:revert`). Mirrors the connection settings
 * declared in `app.module.ts` but lives outside NestJS' DI so the CLI
 * can boot without spinning up the full module graph.
 *
 * `synchronize` is hard-coded to `false` here — the CLI exists to manage
 * migrations, never to auto-mutate the schema. The runtime
 * `TypeOrmModule` config in `app.module.ts` keeps `synchronize: true`
 * for local dev (fast entity iteration) and flips it to `false` in
 * production where migrations are the only sanctioned schema-change
 * mechanism.
 */
loadEnv({ path: join(process.cwd(), '.env') });

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'fliks',
  password: process.env.DB_PASSWORD ?? 'fliks',
  database: process.env.DB_NAME ?? 'fliks',
  entities: [join(__dirname, '**', '*.entity.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  synchronize: false,
});
