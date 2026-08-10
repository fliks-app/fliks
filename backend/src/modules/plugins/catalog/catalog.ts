import * as semver from 'semver';
import type { PluginKind } from '../../../common/plugin-contract';

/**
 * One published version's compatibility declaration — the same two axes as a plugin
 * manifest (`pluginApi` exact, `fliks` a lower-bounded range), see
 * `plans/plugin-system.plan.md`, "The four skew cases". Everything else about a
 * version (download location, hashes) is install-pipeline (PR 7.2) concern and
 * opaque here, so it passes through the index signature untouched.
 */
export interface CatalogVersionEntry {
  version: string;
  pluginApi: number;
  fliks: string;
  [key: string]: unknown;
}

export interface CatalogPluginEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  kind: PluginKind;
  /** Absolute URL to a logo image — opaque, display-only, never fetched server-side. */
  logo?: string;
  versions: CatalogVersionEntry[];
}

export interface CatalogDocument {
  plugins: CatalogPluginEntry[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isVersionEntry(v: unknown): v is CatalogVersionEntry {
  return (
    isRecord(v) &&
    typeof v.version === 'string' &&
    v.version.length > 0 &&
    typeof v.pluginApi === 'number' &&
    typeof v.fliks === 'string' &&
    semver.validRange(v.fliks) !== null
  );
}

function isPluginEntry(v: unknown): v is CatalogPluginEntry {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.name === 'string' &&
    typeof v.description === 'string' &&
    typeof v.author === 'string' &&
    (v.kind === 'data' || v.kind === 'process') &&
    (v.logo === undefined || typeof v.logo === 'string') &&
    Array.isArray(v.versions) &&
    v.versions.length > 0 &&
    v.versions.every(isVersionEntry)
  );
}

/**
 * Structural validation only, same posture as `archive/manifest-parser.ts`'s
 * `parseManifest`: a signature proves who wrote the bytes, not that the JSON
 * inside them is well-formed, so this still has to fail closed on garbage.
 */
export function parseCatalogDocument(bytes: Buffer): CatalogDocument | null {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(json) || !Array.isArray(json.plugins) || !json.plugins.every(isPluginEntry)) {
    return null;
  }
  return json as unknown as CatalogDocument;
}

export interface HiddenVersionsSummary {
  count: number;
  /** The lowest Fliks version that would reveal at least one hidden version, or null
   *  when upgrading reveals nothing. Only versions excluded by their `fliks` range with
   *  a floor above the running version qualify: a version hidden by a `pluginApi`
   *  mismatch, or by a range whose upper bound is already behind us, is not something a
   *  version number in this document can promise to fix, and offering one would tell the
   *  user to upgrade to a release they are already past. */
  minFliksVersion: string | null;
}

export interface FilteredCatalogEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  kind: PluginKind;
  logo?: string;
  /** Only versions installable on this core build. A caller iterating this list can
   *  never accidentally offer an incompatible version — there is no boolean to miss. */
  installable: CatalogVersionEntry[];
  /** Null when nothing is hidden. A plugin with an empty `installable` list still
   *  appears in the result, carrying this instead — never a bare empty page. */
  hidden: HiddenVersionsSummary | null;
}

export interface FilteredCatalog {
  plugins: FilteredCatalogEntry[];
}

function isInstallable(v: CatalogVersionEntry, pluginApiVersion: number, fliksVersion: string): boolean {
  return v.pluginApi === pluginApiVersion && semver.satisfies(fliksVersion, v.fliks);
}

function summarizeHidden(
  hidden: CatalogVersionEntry[],
  fliksVersion: string,
): HiddenVersionsSummary | null {
  if (hidden.length === 0) return null;
  const reachable = hidden
    .filter((v) => !semver.satisfies(fliksVersion, v.fliks))
    .map((v) => semver.minVersion(v.fliks))
    .filter((v): v is semver.SemVer => v !== null && semver.gt(v, fliksVersion));
  const lowest = reachable.length
    ? reachable.reduce((min, v) => (semver.lt(v, min) ? v : min))
    : null;
  return { count: hidden.length, minFliksVersion: lowest?.version ?? null };
}

/**
 * `pluginApi` exact equality and `semver.satisfies` against the running core version
 * — the same two checks `PluginRegistryService.register` runs at load, applied here
 * one layer earlier so the admin never sees a version they cannot install.
 */
export function filterCatalog(document: CatalogDocument, pluginApiVersion: number, fliksVersion: string): FilteredCatalog {
  return {
    plugins: document.plugins.map((entry) => {
      const installable: CatalogVersionEntry[] = [];
      const hidden: CatalogVersionEntry[] = [];
      for (const version of entry.versions) {
        (isInstallable(version, pluginApiVersion, fliksVersion) ? installable : hidden).push(version);
      }
      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        author: entry.author,
        kind: entry.kind,
        logo: entry.logo,
        installable,
        hidden: summarizeHidden(hidden, fliksVersion),
      };
    }),
  };
}
