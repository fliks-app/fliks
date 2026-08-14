import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { MAX_PLUGIN_ID_LENGTH, PLUGIN_ID_PATTERN } from './archive';
import { PluginInstallException } from './plugin-install.exception';
import type { ProcessPluginManifest } from '../../common/plugin-contract';

const CORE_REF_PATTERN = /^[a-z_][a-z0-9_]*$/;
const MAX_CORE_REF_LENGTH = 63;
const HEX_PASSWORD_PATTERN = /^[0-9a-f]{48}$/;

/** `acme.tool` -> `plugin_acme_tool`. Role name and schema name are the same string. */
export function pluginDbIdentifier(pluginId: string): string {
  if (!PLUGIN_ID_PATTERN.test(pluginId) || pluginId.length > MAX_PLUGIN_ID_LENGTH) {
    throw new Error(`"${pluginId}" is not a legal plugin id`);
  }
  return `plugin_${pluginId.replace(/\./g, '_')}`;
}

/** Syntax + duplicate check only — the DB probe that resolves these to real tables runs in `provision()`. */
function validateCoreRefNames(coreRefs: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const name of coreRefs) {
    if (!CORE_REF_PATTERN.test(name) || name.length > MAX_CORE_REF_LENGTH) {
      throw new Error(`coreRef ${JSON.stringify(name)} is not a legal table name`);
    }
    if (seen.has(name)) {
      throw new Error(`coreRef ${JSON.stringify(name)} is declared more than once`);
    }
    seen.add(name);
  }
  return [...coreRefs];
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function randomHexPassword(): string {
  const password = randomBytes(24).toString('hex');
  if (!HEX_PASSWORD_PATTERN.test(password)) {
    throw new Error('generated password is not the expected hex shape');
  }
  return password;
}

/** A foreign key from this plugin's own schema into `public` that would block core deletes. */
export interface UnsafeCoreRefFk {
  constraint: string;
  table: string;
  referencedTable: string;
}

function asProvisionFailure(err: unknown): PluginInstallException {
  if (err instanceof PluginInstallException) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new PluginInstallException(HttpStatus.INTERNAL_SERVER_ERROR, 'PLUGIN_DB_PROVISION_FAILED', detail);
}

/**
 * Owns the per-plugin Postgres role + schema. Every identifier interpolated
 * into SQL here passed {@link pluginDbIdentifier} or {@link validateCoreRefNames}
 * first; every value is a bound parameter.
 */
@Injectable()
export class PluginDatabaseService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /** P1. No-op when the manifest declares `database.schema === false`. */
  async provision(manifest: ProcessPluginManifest): Promise<void> {
    if (manifest.database.schema === false) {
      if (manifest.database.coreRefs.length > 0) {
        throw new PluginInstallException(
          HttpStatus.INTERNAL_SERVER_ERROR,
          'PLUGIN_DB_PROVISION_FAILED',
          'coreRefs declared with database.schema false — no schema to grant them into',
        );
      }
      return;
    }

    let identifier: string;
    let coreRefs: string[];
    try {
      identifier = pluginDbIdentifier(manifest.id);
      coreRefs = validateCoreRefNames(manifest.database.coreRefs);
    } catch (err) {
      throw asProvisionFailure(err);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      for (const table of coreRefs) {
        const rows = await queryRunner.query(
          `SELECT t.table_type FROM information_schema.columns c
             JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE c.table_schema = 'public' AND c.table_name = $1 AND c.column_name = 'id'`,
          [table],
        );
        if (rows[0]?.table_type !== 'BASE TABLE') {
          throw new Error(`coreRef ${JSON.stringify(table)} is not a public base table with an id column`);
        }
      }

      const roleRows = await queryRunner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [identifier]);
      if (roleRows.length === 0) {
        const password = randomHexPassword();
        await queryRunner.query(`CREATE ROLE "${identifier}" LOGIN PASSWORD '${password}'`);
      }

      await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${identifier}" AUTHORIZATION "${identifier}"`);
      const ownerRows = await queryRunner.query(
        'SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1',
        [identifier],
      );
      if (ownerRows[0]?.owner !== identifier) {
        throw new Error(`schema "${identifier}" already exists, owned by "${ownerRows[0]?.owner}"`);
      }

      await queryRunner.query(`GRANT USAGE ON SCHEMA public TO "${identifier}"`);
      await queryRunner.query(`REVOKE REFERENCES ON ALL TABLES IN SCHEMA public FROM "${identifier}"`);
      for (const table of coreRefs) {
        await queryRunner.query(`GRANT REFERENCES (id) ON public."${table}" TO "${identifier}"`);
      }

      await queryRunner.commitTransaction();
    } catch (err) {
      // Rolling back an already-ended transaction throws and would mask a commit failure.
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw asProvisionFailure(err);
    } finally {
      await queryRunner.release();
    }
  }

  /** Only `CASCADE`/`SET NULL` (`confdeltype` 'c'/'n') let a core `DELETE` proceed unattended. */
  async findUnsafeCoreRefFks(pluginId: string): Promise<UnsafeCoreRefFk[]> {
    const identifier = pluginDbIdentifier(pluginId);
    const rows = await this.dataSource.query(
      `SELECT con.conname AS constraint_name, cl.relname AS table_name, fcl.relname AS referenced_table
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         JOIN pg_class fcl ON fcl.oid = con.confrelid
         JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
        WHERE con.contype = 'f' AND ns.nspname = $1 AND fns.nspname = 'public'
          AND con.confdeltype NOT IN ('c', 'n')
        ORDER BY con.conname`,
      [identifier],
    );
    return (rows as { constraint_name: string; table_name: string; referenced_table: string }[]).map((row) => ({
      constraint: row.constraint_name,
      table: row.table_name,
      referencedTable: row.referenced_table,
    }));
  }

  /** P4b — a fresh password per spawn, never persisted. Returns the DSN, or null when this plugin has no provisioned role. */
  async rotatePassword(pluginId: string): Promise<string | null> {
    let identifier: string;
    try {
      identifier = pluginDbIdentifier(pluginId);
    } catch (err) {
      throw asProvisionFailure(err);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      const roleRows = await queryRunner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [identifier]);
      if (roleRows.length === 0) return null;

      const password = randomHexPassword();
      await queryRunner.query(`ALTER ROLE "${identifier}" WITH PASSWORD '${password}'`);
      return this.buildDsn(identifier, password);
    } catch (err) {
      throw asProvisionFailure(err);
    } finally {
      await queryRunner.release();
    }
  }

  /** Uninstall. Idempotent: safe when the role, schema or grants were never created. */
  async deprovision(pluginId: string): Promise<void> {
    let identifier: string;
    try {
      identifier = pluginDbIdentifier(pluginId);
    } catch {
      // `provision()` refuses the same ids, so nothing can exist to drop — and
      // throwing here would make such a row impossible to uninstall at all.
      return;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      const roleRows = await queryRunner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [identifier]);
      if (roleRows.length > 0) {
        await queryRunner.query(`DROP OWNED BY "${identifier}"`);
      }
      await queryRunner.query(`DROP SCHEMA IF EXISTS "${identifier}" CASCADE`);
      await queryRunner.query(`DROP ROLE IF EXISTS "${identifier}"`);
    } catch (err) {
      throw asProvisionFailure(err);
    } finally {
      await queryRunner.release();
    }
  }

  /** A leading underscore marks a table as the plugin's own bookkeeping — its migration ledger
   *  above all, which records the schema version and must never be exported or written back. */
  private static isBookkeeping(table: string): boolean {
    return table.startsWith('_');
  }

  /** Base tables in this plugin's own schema, read from the catalogue — the only source export/import may take a table name from. */
  async listSchemaTables(pluginId: string): Promise<string[]> {
    const identifier = pluginDbIdentifier(pluginId);
    const rows = await this.dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [identifier],
    );
    return (rows as { table_name: string }[])
      .map((row) => row.table_name)
      .filter((table) => !PluginDatabaseService.isBookkeeping(table));
  }

  /** True once any base table in this plugin's schema holds at least one row. */
  async schemaHasRows(pluginId: string): Promise<boolean> {
    const identifier = pluginDbIdentifier(pluginId);
    for (const table of await this.listSchemaTables(pluginId)) {
      const rows = await this.dataSource.query(`SELECT 1 FROM ${quoteIdent(identifier)}.${quoteIdent(table)} LIMIT 1`);
      if (rows.length > 0) return true;
    }
    return false;
  }

  /** Every row of every base table in this plugin's own schema, keyed by table name. */
  async exportSchemaRows(pluginId: string): Promise<Record<string, Record<string, unknown>[]>> {
    const identifier = pluginDbIdentifier(pluginId);
    const out: Record<string, Record<string, unknown>[]> = {};
    for (const table of await this.listSchemaTables(pluginId)) {
      out[table] = await this.dataSource.query(`SELECT * FROM ${quoteIdent(identifier)}.${quoteIdent(table)}`);
    }
    return out;
  }

  /**
   * Restores previously exported rows into this plugin's own schema, one transaction for every
   * table. Table and column names are re-checked against the live catalogue on every call, never
   * trusted from `tables` — an unknown table or column throws instead of reaching SQL.
   *
   * ponytail: inserts each table in the document's own key order; a schema whose tables reference
   * each other needs that order to already be dependency-safe. Upgrade to a topological sort over
   * the schema's own FKs if a plugin ever needs one.
   */
  async restoreSchemaRows(pluginId: string, tables: Record<string, Record<string, unknown>[]>): Promise<void> {
    const identifier = pluginDbIdentifier(pluginId);
    const knownTables = new Set(await this.listSchemaTables(pluginId));

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      for (const [table, rows] of Object.entries(tables)) {
        if (!knownTables.has(table)) {
          throw new Error(`table ${JSON.stringify(table)} does not belong to plugin "${pluginId}"'s schema`);
        }
        if (!Array.isArray(rows) || rows.length === 0) continue;

        const columnRows = await queryRunner.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
          [identifier, table],
        );
        const knownColumns = new Set((columnRows as { column_name: string }[]).map((row) => row.column_name));

        for (const row of rows) {
          if (typeof row !== 'object' || row === null) {
            throw new Error(`a row in table ${JSON.stringify(table)} is not an object`);
          }
          const columns = Object.keys(row);
          for (const column of columns) {
            if (!knownColumns.has(column)) {
              throw new Error(`column ${JSON.stringify(column)} does not belong to table ${JSON.stringify(table)}`);
            }
          }
          if (columns.length === 0) continue;
          const columnList = columns.map(quoteIdent).join(', ');
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
          await queryRunner.query(
            `INSERT INTO ${quoteIdent(identifier)}.${quoteIdent(table)} (${columnList}) VALUES (${placeholders})`,
            columns.map((column) => (row as Record<string, unknown>)[column]),
          );
        }
      }
      // Restored rows carry their original ids, so every serial is left behind them and the
      // plugin's first insert would collide.
      for (const table of Object.keys(tables)) {
        if (!knownTables.has(table)) continue;
        const serials = await queryRunner.query(
          `SELECT column_name FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
               AND pg_get_serial_sequence($1 || '.' || $2, column_name) IS NOT NULL`,
          [identifier, table],
        );
        for (const { column_name } of serials as { column_name: string }[]) {
          await queryRunner.query(
            `SELECT setval(
               pg_get_serial_sequence($1 || '.' || $2, $3),
               (SELECT COALESCE(MAX(${quoteIdent(column_name)}), 0) + 1 FROM ${quoteIdent(identifier)}.${quoteIdent(table)}),
               false)`,
            [identifier, table, column_name],
          );
        }
      }
      await queryRunner.commitTransaction();
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw asProvisionFailure(err);
    } finally {
      await queryRunner.release();
    }
  }

  /** Same keys/defaults as `app.module.ts`'s TypeORM factory. `search_path` is the plugin schema only — never `,public`. */
  private buildDsn(identifier: string, password: string): string {
    const host = this.config.get('DB_HOST', 'localhost');
    const port = this.config.get<number>('DB_PORT', 5432);
    const database = this.config.get('DB_NAME', 'fliks');
    const searchPath = encodeURIComponent(`-c search_path=${identifier}`);
    return `postgresql://${identifier}:${encodeURIComponent(password)}@${host}:${port}/${database}?options=${searchPath}`;
  }
}
