import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import type { ConfigService } from '@nestjs/config';

const execFileAsync = promisify(execFile);

const MAX_PSQL_BUFFER = 64 * 1024 * 1024;

export function isCustomPgDumpFormat(buf: Buffer): boolean {
  return buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === 'PGDMP';
}

function pgEnv(password: string): NodeJS.ProcessEnv {
  return { ...process.env, PGPASSWORD: password };
}

/**
 * Writes a Radarr/Sonarr pg_dump upload to a temp DB (same Postgres as Suitarr),
 * runs restore via psql/pg_restore, executes the callback, then drops the DB.
 */
export async function withTemporaryRestoredDatabase(
  config: ConfigService,
  fileBuffer: Buffer,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const host = config.get<string>('DB_HOST', 'localhost');
  const port = config.get<number>('DB_PORT', 5432);
  const user = config.get<string>('DB_USERNAME', 'suitarr');
  const password = config.get<string>('DB_PASSWORD', 'suitarr');
  const dbName = `suitarr_imp_${randomUUID().replace(/-/g, '')}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'suitarr-import-'));
  const custom = isCustomPgDumpFormat(fileBuffer);
  const ext = custom ? '.dump' : '.sql';
  const dumpPath = path.join(tmpDir, `arr${ext}`);
  await fs.writeFile(dumpPath, fileBuffer);

  const env = pgEnv(password);
  const pgCommon = ['-h', host, '-p', String(port), '-U', user];

  try {
    try {
      await execFileAsync('createdb', [...pgCommon, dbName], { env });
      if (custom) {
        await execFileAsync(
          'pg_restore',
          ['--no-owner', '--no-acl', ...pgCommon, '-d', dbName, dumpPath],
          { env, maxBuffer: MAX_PSQL_BUFFER },
        );
      } else {
        await execFileAsync(
          'psql',
          [...pgCommon, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', dumpPath],
          {
            env,
            maxBuffer: MAX_PSQL_BUFFER,
          },
        );
      }
    } catch (e: unknown) {
      const err = e as { stderr?: string; stdout?: string; message?: string };
      const detail =
        err.stderr?.trim() || err.stdout?.trim() || err.message || String(e);
      throw new Error(`PostgreSQL restore failed: ${detail}`);
    }

    const client = new Client({ host, port, user, password, database: dbName });
    await client.connect();
    try {
      await run(client);
    } finally {
      await client.end();
    }
  } finally {
    try {
      await execFileAsync('dropdb', [...pgCommon, '--if-exists', dbName], {
        env,
      });
    } catch {
      /* best effort */
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export function rowMonitored(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

export async function queryRadarrMovies(
  client: Client,
): Promise<
  Array<{
    title: string;
    tmdbId: number;
    year: number | null;
    path: string | null;
    monitored: unknown;
  }>
> {
  const attempts = [
    `SELECT "Title" AS title, "TmdbId" AS tmdbid, "Year" AS year, "Path" AS path, "Monitored" AS monitored FROM "Movies"`,
    `SELECT title, tmdbid AS tmdbid, year, path, monitored FROM movies`,
  ];
  for (const sql of attempts) {
    try {
      const r = await client.query<{
        title: string;
        tmdbid: number;
        year: number | null;
        path: string | null;
        monitored: unknown;
      }>(sql);
      return r.rows.map((row) => ({
        title: row.title,
        tmdbId: row.tmdbid,
        year: row.year,
        path: row.path,
        monitored: row.monitored,
      }));
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'Could not read Movies table — use a Radarr PostgreSQL dump (pg_dump plain SQL or custom -Fc format).',
  );
}

async function tableHasColumn(
  client: Client,
  table: string,
  column: string,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Prefer TmdbId when present on Series (Sonarr v4+), else TvdbId. */
async function sonarrUsesTmdb(client: Client): Promise<boolean> {
  if (await tableHasColumn(client, 'Series', 'TmdbId')) return true;
  if (await tableHasColumn(client, 'series', 'tmdbid')) return true;
  return false;
}

export async function querySonarrSeries(
  client: Client,
): Promise<
  Array<{
    title: string;
    externalId: number;
    year: number | null;
    path: string | null;
    monitored: unknown;
  }>
> {
  const useTmdb = await sonarrUsesTmdb(client);

  const attempts = useTmdb
    ? [
        `SELECT "Title" AS title, "TmdbId" AS extid, "Year" AS year, "Path" AS path, "Monitored" AS monitored FROM "Series"`,
        `SELECT title, tmdbid AS extid, year, path, monitored FROM series`,
      ]
    : [
        `SELECT "Title" AS title, "TvdbId" AS extid, "Year" AS year, "Path" AS path, "Monitored" AS monitored FROM "Series"`,
        `SELECT title, tvdbid AS extid, year, path, monitored FROM series`,
      ];

  for (const sql of attempts) {
    try {
      const r = await client.query<{
        title: string;
        extid: number;
        year: number | null;
        path: string | null;
        monitored: unknown;
      }>(sql);
      return r.rows.map((row) => ({
        title: row.title,
        externalId: row.extid,
        year: row.year,
        path: row.path,
        monitored: row.monitored,
      }));
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'Could not read Series table — use a Sonarr PostgreSQL dump (pg_dump plain SQL or custom -Fc format).',
  );
}
