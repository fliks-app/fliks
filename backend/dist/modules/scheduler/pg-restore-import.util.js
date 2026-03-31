"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCustomPgDumpFormat = isCustomPgDumpFormat;
exports.withTemporaryRestoredDatabase = withTemporaryRestoredDatabase;
exports.rowMonitored = rowMonitored;
exports.queryRadarrMovies = queryRadarrMovies;
exports.querySonarrSeries = querySonarrSeries;
const crypto_1 = require("crypto");
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs_1 = require("fs");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const pg_1 = require("pg");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const MAX_PSQL_BUFFER = 64 * 1024 * 1024;
function isCustomPgDumpFormat(buf) {
    return buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === 'PGDMP';
}
function pgEnv(password) {
    return { ...process.env, PGPASSWORD: password };
}
async function withTemporaryRestoredDatabase(config, fileBuffer, run) {
    const host = config.get('DB_HOST', 'localhost');
    const port = config.get('DB_PORT', 5432);
    const user = config.get('DB_USERNAME', 'suitarr');
    const password = config.get('DB_PASSWORD', 'suitarr');
    const dbName = `suitarr_imp_${(0, crypto_1.randomUUID)().replace(/-/g, '')}`;
    const tmpDir = await fs_1.promises.mkdtemp(path.join(os.tmpdir(), 'suitarr-import-'));
    const custom = isCustomPgDumpFormat(fileBuffer);
    const ext = custom ? '.dump' : '.sql';
    const dumpPath = path.join(tmpDir, `arr${ext}`);
    await fs_1.promises.writeFile(dumpPath, fileBuffer);
    const env = pgEnv(password);
    const pgCommon = ['-h', host, '-p', String(port), '-U', user];
    try {
        try {
            await execFileAsync('createdb', [...pgCommon, dbName], { env });
            if (custom) {
                await execFileAsync('pg_restore', ['--no-owner', '--no-acl', ...pgCommon, '-d', dbName, dumpPath], { env, maxBuffer: MAX_PSQL_BUFFER });
            }
            else {
                await execFileAsync('psql', [...pgCommon, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', dumpPath], {
                    env,
                    maxBuffer: MAX_PSQL_BUFFER,
                });
            }
        }
        catch (e) {
            const err = e;
            const detail = err.stderr?.trim() || err.stdout?.trim() || err.message || String(e);
            throw new Error(`PostgreSQL restore failed: ${detail}`);
        }
        const client = new pg_1.Client({ host, port, user, password, database: dbName });
        await client.connect();
        try {
            await run(client);
        }
        finally {
            await client.end();
        }
    }
    finally {
        try {
            await execFileAsync('dropdb', [...pgCommon, '--if-exists', dbName], { env });
        }
        catch {
        }
        await fs_1.promises.rm(tmpDir, { recursive: true, force: true });
    }
}
function rowMonitored(v) {
    return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}
async function queryRadarrMovies(client) {
    const attempts = [
        `SELECT "Title" AS title, "TmdbId" AS tmdbid, "Year" AS year, "Path" AS path, "Monitored" AS monitored FROM "Movies"`,
        `SELECT title, tmdbid AS tmdbid, year, path, monitored FROM movies`,
    ];
    for (const sql of attempts) {
        try {
            const r = await client.query(sql);
            return r.rows.map((row) => ({
                title: row.title,
                tmdbId: row.tmdbid,
                year: row.year,
                path: row.path,
                monitored: row.monitored,
            }));
        }
        catch {
        }
    }
    throw new Error('Could not read Movies table — use a Radarr PostgreSQL dump (pg_dump plain SQL or custom -Fc format).');
}
async function tableHasColumn(client, table, column) {
    const r = await client.query(`SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`, [table, column]);
    return (r.rowCount ?? 0) > 0;
}
async function sonarrUsesTmdb(client) {
    if (await tableHasColumn(client, 'Series', 'TmdbId'))
        return true;
    if (await tableHasColumn(client, 'series', 'tmdbid'))
        return true;
    return false;
}
async function querySonarrSeries(client) {
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
            const r = await client.query(sql);
            return r.rows.map((row) => ({
                title: row.title,
                externalId: row.extid,
                year: row.year,
                path: row.path,
                monitored: row.monitored,
            }));
        }
        catch {
        }
    }
    throw new Error('Could not read Series table — use a Sonarr PostgreSQL dump (pg_dump plain SQL or custom -Fc format).');
}
//# sourceMappingURL=pg-restore-import.util.js.map