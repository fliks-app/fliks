import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { PluginDatabaseService, pluginDbIdentifier } from './plugin-database.service';
import { PluginInstallException } from './plugin-install.exception';
import { minimalProcessManifest } from './archive/test-manifests';

interface Recorder {
  events: string[];
  queries: { sql: string; parameters: unknown[] }[];
}

interface Fixtures {
  roleExists?: boolean;
  schemaOwner?: string;
  /** Names the fake probe resolves to a `public` `BASE TABLE` carrying an `id` column. */
  baseTables?: readonly string[];
}

function makeRecorder(): Recorder {
  return { events: [], queries: [] };
}

/** Routes each query by a substring of its SQL — enough to answer the three probes `provision`/`rotatePassword`/`deprovision` run. */
function respondFor(fixtures: Fixtures) {
  return (sql: string, parameters: unknown[]): unknown[] => {
    if (sql.includes('FROM pg_roles')) return fixtures.roleExists ? [{ x: 1 }] : [];
    if (sql.includes('FROM pg_namespace')) return fixtures.schemaOwner ? [{ owner: fixtures.schemaOwner }] : [];
    if (sql.includes('information_schema')) {
      const table = parameters[0] as string;
      return fixtures.baseTables?.includes(table) ? [{ table_type: 'BASE TABLE' }] : [];
    }
    return [];
  };
}

function fakeQueryRunner(
  recorder: Recorder,
  respond: (sql: string, parameters: unknown[]) => unknown[],
  failCommit = false,
) {
  // `isTransactionActive` is tracked the way the real runner tracks it: rolling
  // back once it is false throws, which is what the service guards against.
  const runner = {
    isTransactionActive: false,
    connect: jest.fn(async () => {
      recorder.events.push('connect');
    }),
    startTransaction: jest.fn(async () => {
      recorder.events.push('startTransaction');
      runner.isTransactionActive = true;
    }),
    commitTransaction: jest.fn(async () => {
      recorder.events.push('commitTransaction');
      runner.isTransactionActive = false;
      if (failCommit) throw new Error('COMMIT failed at the server');
    }),
    rollbackTransaction: jest.fn(async () => {
      recorder.events.push('rollbackTransaction');
      if (!runner.isTransactionActive) throw new Error('TransactionNotStartedError');
      runner.isTransactionActive = false;
    }),
    release: jest.fn(async () => {
      recorder.events.push('release');
    }),
    query: jest.fn(async (sql: string, parameters: unknown[] = []) => {
      recorder.events.push('query');
      recorder.queries.push({ sql, parameters });
      return respond(sql, parameters);
    }),
  };
  return runner;
}

function fakeDataSource(recorder: Recorder, fixtures: Fixtures = {}, failCommit = false) {
  const respond = respondFor(fixtures);
  return { createQueryRunner: jest.fn(() => fakeQueryRunner(recorder, respond, failCommit)) };
}

function fakeConfig(overrides: Record<string, unknown> = {}) {
  return { get: jest.fn((key: string, fallback?: unknown) => (key in overrides ? overrides[key] : fallback)) };
}

function service(dataSource: ReturnType<typeof fakeDataSource>, config: ReturnType<typeof fakeConfig> = fakeConfig()) {
  return new PluginDatabaseService(dataSource as unknown as DataSource, config as unknown as ConfigService);
}

/** Collapses incidental whitespace so a multi-line template literal compares like the single statement it is. */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function hasBareSemicolon(sql: string): boolean {
  return sql.replace(/'[^']*'/g, "''").includes(';');
}

describe('pluginDbIdentifier', () => {
  it('maps a dotted id to the role/schema name', () => {
    expect(pluginDbIdentifier('fliks.download')).toBe('plugin_fliks_download');
    expect(pluginDbIdentifier('fliks')).toBe('plugin_fliks');
  });

  it('accepts the longest id that still fits an untruncated identifier', () => {
    // Postgres truncates past 63 bytes, so 56 is the last length two ids cannot collide at.
    expect(pluginDbIdentifier('a'.repeat(56))).toHaveLength(63);
  });

  const badIds = [
    'fliks.download; DROP TABLE media',
    'fliks."; DROP',
    '"fliks"',
    '../../etc/passwd',
    'fliks..download',
    '.fliks',
    'fliks.',
    'Fliks.Download',
    'fliks_download',
    'fliks-download',
    '1fliks',
    '',
    'a'.repeat(57),
    'fliks.download\nDROP',
    'fliks.dow nload',
    'flіks.download', // Cyrillic 'і' (U+0456), a homoglyph for latin 'i'
  ];

  it.each(badIds)('rejects %j — and provision() never touches the database for it', async (id) => {
    expect(() => pluginDbIdentifier(id)).toThrow();

    const recorder = makeRecorder();
    const dataSource = fakeDataSource(recorder);
    const manifest = minimalProcessManifest({}, { id, database: { schema: true, coreRefs: [] } });

    await expect(service(dataSource).provision(manifest)).rejects.toThrow(PluginInstallException);
    expect(recorder.queries).toHaveLength(0);
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });
});

describe('PluginDatabaseService.provision', () => {
  it('no-ops when database.schema is false and coreRefs is empty', async () => {
    const recorder = makeRecorder();
    const dataSource = fakeDataSource(recorder);
    const manifest = minimalProcessManifest({}, { database: { schema: false, coreRefs: [] } });

    await expect(service(dataSource).provision(manifest)).resolves.toBeUndefined();
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('throws when database.schema is false but coreRefs is declared — nothing to grant them into', async () => {
    const recorder = makeRecorder();
    const dataSource = fakeDataSource(recorder);
    const manifest = minimalProcessManifest({}, { database: { schema: false, coreRefs: ['media'] } });

    await expect(service(dataSource).provision(manifest)).rejects.toThrow(PluginInstallException);
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('emits the exact statement sequence for two coreRefs: probes, role, schema, owner check, usage, revoke, then the grants', async () => {
    const recorder = makeRecorder();
    const dataSource = fakeDataSource(recorder, {
      roleExists: false,
      schemaOwner: 'plugin_fliks_download',
      baseTables: ['media', 'episodes'],
    });
    const manifest = minimalProcessManifest({}, {
      id: 'fliks.download',
      database: { schema: true, coreRefs: ['media', 'episodes'] },
    });

    await service(dataSource).provision(manifest);

    expect(recorder.events).toEqual([
      'connect',
      'startTransaction',
      'query',
      'query',
      'query',
      'query',
      'query',
      'query',
      'query',
      'query',
      'query',
      'query',
      'commitTransaction',
      'release',
    ]);
    expect(recorder.queries).toHaveLength(10);
    const sql = recorder.queries.map((q) => normalizeSql(q.sql));
    const probe =
      "SELECT t.table_type FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE c.table_schema = 'public' AND c.table_name = $1 AND c.column_name = 'id'";
    expect(sql[0]).toBe(probe);
    expect(recorder.queries[0].parameters).toEqual(['media']);
    expect(sql[1]).toBe(probe);
    expect(recorder.queries[1].parameters).toEqual(['episodes']);
    expect(sql[2]).toBe('SELECT 1 FROM pg_roles WHERE rolname = $1');
    expect(recorder.queries[2].parameters).toEqual(['plugin_fliks_download']);
    expect(sql[3]).toMatch(/^CREATE ROLE "plugin_fliks_download" LOGIN PASSWORD '[0-9a-f]{48}'$/);
    expect(sql[4]).toBe('CREATE SCHEMA IF NOT EXISTS "plugin_fliks_download" AUTHORIZATION "plugin_fliks_download"');
    expect(sql[5]).toBe('SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1');
    expect(recorder.queries[5].parameters).toEqual(['plugin_fliks_download']);
    expect(sql[6]).toBe('GRANT USAGE ON SCHEMA public TO "plugin_fliks_download"');
    expect(sql[7]).toBe('REVOKE REFERENCES ON ALL TABLES IN SCHEMA public FROM "plugin_fliks_download"');
    expect(sql[8]).toBe('GRANT REFERENCES (id) ON public."media" TO "plugin_fliks_download"');
    expect(sql[9]).toBe('GRANT REFERENCES (id) ON public."episodes" TO "plugin_fliks_download"');
    // Positions 6/7 (usage/revoke) precede 8/9 (grants) in `recorder.queries`, which is push order == execution order.
  });

  it('skips CREATE ROLE when pg_roles already reports the role', async () => {
    const recorder = makeRecorder();
    const dataSource = fakeDataSource(recorder, { roleExists: true, schemaOwner: 'plugin_fliks_download', baseTables: [] });
    const manifest = minimalProcessManifest({}, { id: 'fliks.download', database: { schema: true, coreRefs: [] } });

    await service(dataSource).provision(manifest);

    const sql = recorder.queries.map((q) => normalizeSql(q.sql));
    expect(sql.some((s) => s.startsWith('CREATE ROLE'))).toBe(false);
  });

  it('throws, rolls back and grants nothing when the schema already exists owned by a different role', async () => {
    const recorder = makeRecorder();
    const dataSource = fakeDataSource(recorder, { roleExists: true, schemaOwner: 'someone_else', baseTables: [] });
    const manifest = minimalProcessManifest({}, { id: 'fliks.ownertest', database: { schema: true, coreRefs: [] } });

    await expect(service(dataSource).provision(manifest)).rejects.toThrow(PluginInstallException);

    expect(recorder.events).toContain('rollbackTransaction');
    expect(recorder.events).not.toContain('commitTransaction');
    expect(recorder.queries.some((q) => /^GRANT/i.test(q.sql.trim()))).toBe(false);
  });

  it('reports the commit failure itself, not a second error from rolling back an ended transaction', async () => {
    const recorder = makeRecorder();
    const dataSource = fakeDataSource(
      recorder,
      { roleExists: true, schemaOwner: 'plugin_fliks_download', baseTables: [] },
      true,
    );
    const manifest = minimalProcessManifest({}, { id: 'fliks.download', database: { schema: true, coreRefs: [] } });

    await expect(service(dataSource).provision(manifest)).rejects.toThrow('COMMIT failed at the server');
    expect(recorder.events).not.toContain('rollbackTransaction');
    expect(recorder.events).toContain('release');
  });

  const BASE_TABLES = ['media'];
  const coreRefCases: { name: string; coreRefs: string[]; rejectedAfterProbe: boolean }[] = [
    { name: 'media; DROP TABLE users', coreRefs: ['media; DROP TABLE users'], rejectedAfterProbe: false },
    { name: 'media"', coreRefs: ['media"'], rejectedAfterProbe: false },
    { name: '"media"', coreRefs: ['"media"'], rejectedAfterProbe: false },
    { name: 'public.media', coreRefs: ['public.media'], rejectedAfterProbe: false },
    { name: 'pg_authid', coreRefs: ['pg_authid'], rejectedAfterProbe: true },
    { name: 'information_schema.tables', coreRefs: ['information_schema.tables'], rejectedAfterProbe: false },
    { name: 'MEDIA', coreRefs: ['MEDIA'], rejectedAfterProbe: false },
    { name: 'does_not_exist', coreRefs: ['does_not_exist'], rejectedAfterProbe: true },
    { name: '(empty string)', coreRefs: [''], rejectedAfterProbe: false },
    { name: 'a'.repeat(64) + ' (64 chars)', coreRefs: ['a'.repeat(64)], rejectedAfterProbe: false },
    { name: 'duplicate of a valid entry', coreRefs: ['media', 'media'], rejectedAfterProbe: false },
    { name: 'table with no id column', coreRefs: ['profile_no_id'], rejectedAfterProbe: true },
  ];

  it.each(coreRefCases)('rejects coreRef case: $name', async ({ coreRefs, rejectedAfterProbe }) => {
    const recorder = makeRecorder();
    const dataSource = fakeDataSource(recorder, { roleExists: false, schemaOwner: 'plugin_fliks_coretest', baseTables: BASE_TABLES });
    const manifest = minimalProcessManifest({}, { id: 'fliks.coretest', database: { schema: true, coreRefs } });

    await expect(service(dataSource).provision(manifest)).rejects.toThrow(PluginInstallException);

    if (rejectedAfterProbe) {
      expect(recorder.queries.length).toBeGreaterThan(0);
      expect(recorder.queries.some((q) => /^(GRANT|CREATE)/i.test(q.sql.trim()))).toBe(false);
      expect(recorder.events).toContain('rollbackTransaction');
      expect(recorder.events).not.toContain('commitTransaction');
    } else {
      expect(recorder.queries).toHaveLength(0);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    }
  });

  it('every passing-case statement has no bare semicolon, and every DDL statement carries the expected quoted identifier', async () => {
    const provisionRecorder = makeRecorder();
    await service(
      fakeDataSource(provisionRecorder, { roleExists: false, schemaOwner: 'plugin_fliks_download', baseTables: ['media', 'episodes'] }),
    ).provision(minimalProcessManifest({}, { id: 'fliks.download', database: { schema: true, coreRefs: ['media', 'episodes'] } }));

    const rotateRecorder = makeRecorder();
    await service(fakeDataSource(rotateRecorder, { roleExists: true })).rotatePassword('fliks.download');

    const deprovisionRecorder = makeRecorder();
    await service(fakeDataSource(deprovisionRecorder, { roleExists: true })).deprovision('fliks.download');

    const allSql = [...provisionRecorder.queries, ...rotateRecorder.queries, ...deprovisionRecorder.queries].map((q) => q.sql);
    for (const sql of allSql) {
      expect(hasBareSemicolon(sql)).toBe(false);
    }
    const ddl = allSql.filter((sql) => /^(CREATE|GRANT|REVOKE|ALTER|DROP)/i.test(sql.trim()));
    expect(ddl.length).toBeGreaterThan(0);
    for (const sql of ddl) {
      expect(sql).toContain('"plugin_fliks_download"');
    }
  });
});

describe('PluginDatabaseService.rotatePassword', () => {
  it('returns null when the role has never been provisioned', async () => {
    const recorder = makeRecorder();
    const dataSource = fakeDataSource(recorder, { roleExists: false });

    await expect(service(dataSource).rotatePassword('fliks.download')).resolves.toBeNull();
    expect(recorder.queries).toHaveLength(1);
    expect(recorder.queries[0].sql).toContain('pg_roles');
  });

  it('returns a DSN pinning search_path to the plugin schema alone, with a fresh 48-hex password each call', async () => {
    const dsnPattern =
      /^postgresql:\/\/plugin_fliks_download:[0-9a-f]{48}@localhost:5432\/fliks\?options=-c%20search_path%3Dplugin_fliks_download$/;

    const first = await service(fakeDataSource(makeRecorder(), { roleExists: true })).rotatePassword('fliks.download');
    const second = await service(fakeDataSource(makeRecorder(), { roleExists: true })).rotatePassword('fliks.download');

    expect(first).toMatch(dsnPattern);
    expect(second).toMatch(dsnPattern);
    expect(first).not.toBe(second);
  });

  it('reads host/port/database from ConfigService with app.module.ts defaults', async () => {
    const config = fakeConfig({ DB_HOST: 'db.internal', DB_PORT: 5433, DB_NAME: 'fliks_test' });

    const dsn = await service(fakeDataSource(makeRecorder(), { roleExists: true }), config).rotatePassword('fliks.download');

    expect(dsn).toMatch(/^postgresql:\/\/plugin_fliks_download:[0-9a-f]{48}@db\.internal:5433\/fliks_test\?/);
  });
});

describe('PluginDatabaseService.deprovision', () => {
  it('drops owned objects, the schema and the role, in that order, when the role exists', async () => {
    const recorder = makeRecorder();
    await service(fakeDataSource(recorder, { roleExists: true })).deprovision('fliks.download');

    const sql = recorder.queries.map((q) => normalizeSql(q.sql));
    expect(sql).toEqual([
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      'DROP OWNED BY "plugin_fliks_download"',
      'DROP SCHEMA IF EXISTS "plugin_fliks_download" CASCADE',
      'DROP ROLE IF EXISTS "plugin_fliks_download"',
    ]);
  });

  it('touches no database for an id provision could never have accepted', async () => {
    const recorder = makeRecorder();
    const dataSource = fakeDataSource(recorder, { roleExists: true });

    await expect(service(dataSource).deprovision('../../etc/passwd')).resolves.toBeUndefined();
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('is a no-op that throws nothing when the role never existed', async () => {
    const recorder = makeRecorder();
    await expect(service(fakeDataSource(recorder, { roleExists: false })).deprovision('fliks.download')).resolves.toBeUndefined();

    const sql = recorder.queries.map((q) => normalizeSql(q.sql));
    expect(sql).toEqual([
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      'DROP SCHEMA IF EXISTS "plugin_fliks_download" CASCADE',
      'DROP ROLE IF EXISTS "plugin_fliks_download"',
    ]);
  });
});
