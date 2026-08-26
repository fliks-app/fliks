import * as semver from 'semver';
import { fliksRangeVersion } from '../../../common/plugin-contract';
import type { PluginKind } from '../../../common/plugin-contract';

/**
 * One published version's compatibility declaration — the same two axes as a plugin
 * manifest (`pluginApi` exact, `fliks` a lower-bounded range). Everything else about a
 * version (download location, hashes) is install-pipeline concern and
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

/**
 * A publisher-issued revocation. Absent `version` denies every version of `pluginId`; absent
 * `sha256` denies by version alone. See docs/plugins.md for the authority rule this enforces.
 */
export interface CatalogDenyEntry {
  pluginId: string;
  version?: string;
  sha256?: string;
  reason: string;
}

export interface CatalogDocument {
  plugins: CatalogPluginEntry[];
  denyList?: CatalogDenyEntry[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isDenyEntry(v: unknown): v is CatalogDenyEntry {
  return (
    isRecord(v) &&
    typeof v.pluginId === 'string' &&
    v.pluginId.length > 0 &&
    (v.version === undefined || typeof v.version === 'string') &&
    (v.sha256 === undefined || typeof v.sha256 === 'string') &&
    typeof v.reason === 'string' &&
    v.reason.length > 0
  );
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
  const document: CatalogDocument = { plugins: json.plugins as CatalogPluginEntry[] };
  // A denyList entry is untrusted the same as everything else here; a garbled one is dropped,
  // never allowed to fail the whole (already signature-verified) document.
  if (Array.isArray(json.denyList)) {
    document.denyList = json.denyList.filter(isDenyEntry);
  }
  return document;
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
  /** Only versions installable on this core build, oldest to newest, so the last entry is the one
   *  to offer as an update. A caller iterating this list cannot offer an incompatible version. */
  installable: CatalogVersionEntry[];
  /** Null when nothing is hidden. A plugin with an empty `installable` list still
   *  appears in the result, carrying this instead — never a bare empty page. */
  hidden: HiddenVersionsSummary | null;
}

export interface FilteredCatalog {
  plugins: FilteredCatalogEntry[];
  /** Carried through unfiltered by compatibility — a denied version is denied regardless of
   *  whether this core could otherwise install it. Always an array, never absent. */
  denyList: CatalogDenyEntry[];
}

/** What a catalog publishes on a version whose archive has not been built and signed yet. It is
 *  valid lowercase hex, so no format check tells it apart from a real checksum. */
const PLACEHOLDER_SHA256 = '0'.repeat(64);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A version core could not verify if it downloaded it. `zipUrl`/`sha256` are install-pipeline
 * fields, read here because "can this be installed" is this function's question: an entry whose
 * checksum is a placeholder or malformed fails its checksum check on every attempt, so offering
 * it turns a publisher's mid-release state into an error the admin has no way to act on.
 */
function hasVerifiableArchive(v: CatalogVersionEntry): boolean {
  const { zipUrl, sha256 } = v as { zipUrl?: unknown; sha256?: unknown };
  if (typeof zipUrl !== 'string' || zipUrl.length === 0) return false;
  return typeof sha256 === 'string' && SHA256_PATTERN.test(sha256) && sha256 !== PLACEHOLDER_SHA256;
}

function isInstallable(v: CatalogVersionEntry, supportedApiVersions: readonly number[], fliksVersion: string): boolean {
  return (
    supportedApiVersions.includes(v.pluginApi) &&
    semver.satisfies(fliksRangeVersion(fliksVersion), v.fliks) &&
    hasVerifiableArchive(v)
  );
}

function summarizeHidden(
  hidden: CatalogVersionEntry[],
  fliksVersion: string,
): HiddenVersionsSummary | null {
  if (hidden.length === 0) return null;
  const reachable = hidden
    .filter((v) => !semver.satisfies(fliksRangeVersion(fliksVersion), v.fliks))
    .map((v) => semver.minVersion(v.fliks))
    .filter((v): v is semver.SemVer => v !== null && semver.gt(v, fliksVersion));
  const lowest = reachable.length
    ? reachable.reduce((min, v) => (semver.lt(v, min) ? v : min))
    : null;
  return { count: hidden.length, minFliksVersion: lowest?.version ?? null };
}

/**
 * The same two checks `PluginRegistryService.register` runs at load, applied one layer earlier
 * so an admin never sees a version they cannot install.
 */
export function filterCatalog(
  document: CatalogDocument,
  supportedApiVersions: readonly number[],
  fliksVersion: string,
): FilteredCatalog {
  return {
    denyList: document.denyList ?? [],
    plugins: document.plugins.map((entry) => {
      const installable: CatalogVersionEntry[] = [];
      const hidden: CatalogVersionEntry[] = [];
      for (const version of entry.versions) {
        (isInstallable(version, supportedApiVersions, fliksVersion) ? installable : hidden).push(version);
      }
      // A catalogue document lists versions in whatever order it likes; consumers read the last as newest.
      installable.sort((a, b) => semver.compare(a.version, b.version));
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

/** One source's cached deny-list plus the key that verified the catalogue carrying it —
 *  the pair {@link findDenial} needs to enforce the authority rule below. */
export interface DenyListSource {
  denyList: CatalogDenyEntry[];
  signedByKeyId: string | null;
}

/**
 * Pulls `denyList`/`signedByKeyId` back out of a `PluginSource.cachedCatalog` blob — opaque
 * jsonb, so re-validated defensively rather than trusted as already-shaped `FilteredCatalog`.
 */
export function extractCachedDenyList(cachedCatalog: Record<string, unknown> | null): DenyListSource {
  if (!cachedCatalog) return { denyList: [], signedByKeyId: null };
  const denyList = Array.isArray(cachedCatalog.denyList) ? cachedCatalog.denyList.filter(isDenyEntry) : [];
  const signedByKeyId = typeof cachedCatalog.signedByKeyId === 'string' ? cachedCatalog.signedByKeyId : null;
  return { denyList, signedByKeyId };
}

export interface DeniedPackage {
  pluginId: string;
  version: string;
  sha256: string;
  verifiedByKeyId: string | null;
}

/**
 * Revocation authority is signing authority: an entry only denies a package whose
 * `verifiedByKeyId` is the same key that verified the catalogue carrying the entry. A package
 * nobody vouched for (`verifiedByKeyId: null`) matches no source and so is never denied.
 */
export function findDenial(pkg: DeniedPackage, sources: readonly DenyListSource[]): { reason: string } | null {
  if (!pkg.verifiedByKeyId) return null;
  for (const source of sources) {
    if (source.signedByKeyId !== pkg.verifiedByKeyId) continue;
    for (const entry of source.denyList) {
      if (entry.pluginId !== pkg.pluginId) continue;
      if (entry.version !== undefined && entry.version !== pkg.version) continue;
      if (entry.sha256 !== undefined && entry.sha256 !== pkg.sha256) continue;
      return { reason: entry.reason };
    }
  }
  return null;
}
