import type { FieldDef } from './ui-contribution';

/**
 * One `provides.indexers[]` entry: a named tracker over a core driver
 * (`driverApi`) at a known `endpoint`, with the settings a user must
 * supply. Not part of the `ui-contribution.ts` drift gate — that job only
 * compiles `ui-contribution.ts` against its client mirror, and this type
 * has no client mirror yet.
 */
export interface IndexerDescriptor {
  /** Unique within the plugin; must not contain `INDEXER_ID_SEPARATOR`. */
  key: string;
  name: string;
  /** Core driver this descriptor runs over, e.g. "torznab". */
  driverApi: string;
  /** Absolute http(s) base URL — the only user input left is credentials. */
  endpoint: string;
  /** Rendered by the same `<app-schema-form>` as any other plugin credential. */
  settings: FieldDef[];
}

/** Joins a plugin id and a descriptor key for storage in `Indexer.implementation`. */
export const INDEXER_ID_SEPARATOR = '.';

/** Namespaces a descriptor key by plugin id, so two plugins can't collide
 *  and an orphaned indexer row is traceable to the plugin that defined it. */
export function buildIndexerImplementationId(pluginId: string, key: string): string {
  return `${pluginId}${INDEXER_ID_SEPARATOR}${key}`;
}

/**
 * Inverse of `buildIndexerImplementationId`. Plugin ids are commonly
 * reverse-domain (`fliks.test-plugin`) and may themselves contain the
 * separator, so the split is taken from the right — the key must not.
 * Returns null when `implementation` isn't a namespaced descriptor id
 * (e.g. the legacy plain `"torznab"` value).
 */
export function parseIndexerImplementationId(implementation: string): { pluginId: string; key: string } | null {
  const i = implementation.lastIndexOf(INDEXER_ID_SEPARATOR);
  if (i <= 0 || i === implementation.length - 1) return null;
  return { pluginId: implementation.slice(0, i), key: implementation.slice(i + 1) };
}
