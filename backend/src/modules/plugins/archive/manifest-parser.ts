import * as path from 'path';
import type {
  DataPluginManifest,
  PluginManifest,
  PluginRoute,
  ProcessPluginManifest,
} from '../../../common/plugin-contract';
import { PluginScope } from '../../../common/plugin-contract';

/** Legal top-level keys on a `data` manifest; reused by the data-tier validator. */
export const BASE_KEYS = new Set([
  'id',
  'pluginApi',
  'name',
  'version',
  'fliks',
  'author',
  'description',
  'license',
  'logo',
  'homepage',
  'ui',
  'events',
  'i18n',
  'kind',
]);

const PROCESS_KEYS = new Set([
  ...BASE_KEYS,
  'runtime',
  'memoryMb',
  'files',
  'database',
  'routes',
  'scopes',
  'ingestRoots',
  'jobs',
  'permissions',
  // Accepted so an installed plugin declaring it keeps loading; nothing reads it.
  'checklist',
]);

const PLUGIN_SCOPES: ReadonlySet<string> = new Set<PluginScope>([
  'media:read',
  'acquisition:candidates',
  'releases:score',
  'requests:progress',
  'ingest:write',
  'events:emit',
  'config:rw',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasRequiredBaseFields(json: Record<string, unknown>): boolean {
  return (
    typeof json.id === 'string' &&
    json.id.length > 0 &&
    typeof json.pluginApi === 'number' &&
    typeof json.name === 'string' &&
    json.name.length > 0 &&
    typeof json.version === 'string' &&
    json.version.length > 0 &&
    typeof json.fliks === 'string' &&
    json.fliks.length > 0 &&
    typeof json.author === 'string' &&
    typeof json.description === 'string' &&
    typeof json.license === 'string' &&
    typeof json.logo === 'string' &&
    (json.homepage === undefined || typeof json.homepage === 'string')
  );
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return isRecord(v) && Object.values(v).every((x) => typeof x === 'string');
}

function isI18nDict(v: unknown): v is Record<string, Record<string, string>> {
  return isRecord(v) && Object.values(v).every((locale) => isStringRecord(locale));
}

/** True if any key is a dotted ancestor of another — `insertValue` would clobber one turning the flat dict into a tree. */
function hasBranchConflict(keys: readonly string[]): boolean {
  return keys.some((key, i) => keys.some((other, j) => i !== j && other.startsWith(`${key}.`)));
}

/** Every key under one root branch, the same root in every locale: which root is the plugin's own
 *  choice, but `PluginRegistryService` refuses a root another loaded plugin already claims. */
function i18nClaimsOneRoot(i18n: Record<string, Record<string, string>>): boolean {
  const roots = new Set<string>();
  for (const dict of Object.values(i18n)) {
    const keys = Object.keys(dict);
    if (hasBranchConflict(keys)) return false;
    for (const key of keys) {
      const root = key.split('.')[0];
      if (!root || root === key) return false;
      roots.add(root);
    }
  }
  return roots.size <= 1;
}

/** The root branch this manifest's keys sit under, or null when it declares none. */
export function i18nRoot(manifest: PluginManifest): string | null {
  for (const dict of Object.values(manifest.i18n ?? {})) {
    for (const key of Object.keys(dict)) return key.split('.')[0] ?? null;
  }
  return null;
}

/** Absolute, normalised, never a volume root. The flavour comes from the value, never from the host:
 *  a manifest is signed once and must resolve identically wherever core runs. */
function isValidIngestRoot(root: string): boolean {
  const flavour = /^[a-zA-Z]:[\\/]/.test(root) ? path.win32 : path.posix;
  return flavour.isAbsolute(root) && root === flavour.normalize(root) && flavour.dirname(root) !== root;
}

function isRouteArray(v: unknown): v is PluginRoute[] {
  return (
    Array.isArray(v) &&
    v.every(
      (r) =>
        isRecord(r) &&
        typeof r.method === 'string' &&
        typeof r.path === 'string' &&
        typeof r.policy === 'string' &&
        (r.objectGuard === undefined || typeof r.objectGuard === 'string'),
    )
  );
}

function hasRequiredProcessFields(json: Record<string, unknown>): boolean {
  return (
    json.runtime === 'node' &&
    typeof json.memoryMb === 'number' &&
    isStringRecord(json.files) &&
    isRecord(json.database) &&
    typeof json.database.schema === 'boolean' &&
    Array.isArray(json.database.coreRefs) &&
    json.database.coreRefs.every((r) => typeof r === 'string') &&
    isRouteArray(json.routes) &&
    Array.isArray(json.scopes) &&
    json.scopes.length > 0 &&
    json.scopes.every((s) => typeof s === 'string' && PLUGIN_SCOPES.has(s)) &&
    Array.isArray(json.ingestRoots) &&
    json.ingestRoots.every((r) => typeof r === 'string' && isValidIngestRoot(r))
  );
}

/**
 * Structural validation only — required fields, types, unknown-key
 * rejection (mirrors `forbidNonWhitelisted` at `main.ts:76-80`) and the
 * `data`/`process` field split. Deep validation of nested shapes (route
 * `policy`/`objectGuard` against a live registry, `ui.contributions[]`
 * slot legality) needs modules this PR doesn't build; deferred to 3.5/6.1.
 */
export function parseManifest(bytes: Buffer): PluginManifest | null {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  if (!hasRequiredBaseFields(json)) return null;

  if (json.i18n !== undefined) {
    if (!isI18nDict(json.i18n)) return null;
    if (!i18nClaimsOneRoot(json.i18n)) return null;
  }

  if (json.kind === 'data') {
    for (const key of Object.keys(json)) {
      if (!BASE_KEYS.has(key)) return null;
    }
    return json as unknown as DataPluginManifest;
  }

  if (json.kind === 'process') {
    for (const key of Object.keys(json)) {
      if (!PROCESS_KEYS.has(key)) return null;
    }
    if (!hasRequiredProcessFields(json)) return null;
    return json as unknown as ProcessPluginManifest;
  }

  return null;
}
