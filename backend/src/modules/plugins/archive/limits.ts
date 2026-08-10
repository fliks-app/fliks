/**
 * The closed entry-name set (`plans/plugin-system.plan.md`, "The ZIP — a
 * closed literal file list"). Matched by `===` only — never normalised,
 * never case-folded — so path traversal has no class of name to exploit.
 */
export const LEGAL_ENTRY_NAMES = [
  'plugin.json',
  'plugin.json.sig',
  'plugin.js',
  'logo.svg',
  'logo.png',
] as const;
export type LegalEntryName = (typeof LEGAL_ENTRY_NAMES)[number];

/** `process`-only entries; illegal inside a `data` archive. */
export const PROCESS_ONLY_ENTRY_NAMES: ReadonlySet<string> = new Set(['plugin.js']);

export const MAX_ARCHIVE_ENTRIES = 4;
export const MAX_ARCHIVE_COMPRESSED_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 24 * 1024 * 1024;
export const MAX_ENTRY_RATIO = 100;
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_SIGNATURE_BYTES = 256;
export const MAX_PLUGIN_JS_BYTES = 8 * 1024 * 1024;
export const MAX_LOGO_BYTES = 64 * 1024;

/** Mirrors the published catalog's `schema/plugin.schema.v0.json` — core must not be laxer than the catalog. */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/;

/** 63 (Postgres NAMEDATALEN) minus `plugin_`, past which two ids collide onto one schema. */
export const MAX_PLUGIN_ID_LENGTH = 56;

/** Raw byte length of an Ed25519 signature — fixed regardless of message size. */
export const ED25519_SIGNATURE_LENGTH = 64;

/** Per-entry uncompressed-size cap, keyed by the closed name set above. */
export function maxUncompressedBytesFor(name: string): number {
  if (name === 'plugin.json') return MAX_MANIFEST_BYTES;
  if (name === 'plugin.json.sig') return MAX_SIGNATURE_BYTES;
  if (name === 'plugin.js') return MAX_PLUGIN_JS_BYTES;
  return MAX_LOGO_BYTES; // logo.svg | logo.png
}
