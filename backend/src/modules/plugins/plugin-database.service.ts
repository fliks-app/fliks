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

function randomHexPassword(): string {
  const password = randomBytes(24).toString('hex');
  if (!HEX_PASSWORD_PATTERN.test(password)) {
    throw new Error('generated password is not the expected hex shape');
  }
  return password;
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

  /** Same keys/defaults as `app.module.ts`'s TypeORM factory. `search_path` is the plugin schema only — never `,public`. */
  private buildDsn(identifier: string, password: string): string {
    const host = this.config.get('DB_HOST', 'localhost');
    const port = this.config.get<number>('DB_PORT', 5432);
    const database = this.config.get('DB_NAME', 'fliks');
    const searchPath = encodeURIComponent(`-c search_path=${identifier}`);
    return `postgresql://${identifier}:${encodeURIComponent(password)}@${host}:${port}/${database}?options=${searchPath}`;
  }
}
