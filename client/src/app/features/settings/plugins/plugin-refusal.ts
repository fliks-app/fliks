/** Zip-structure and manifest-shape guards (`archive/zip-inspector.ts` V1-V7) — none of them actionable by an admin beyond "get a different build". */
const MALFORMED_CODES = new Set([
  'PLUGIN_BAD_MAGIC',
  'PLUGIN_TOO_MANY_ENTRIES',
  'PLUGIN_UNEXPECTED_ENTRY',
  'PLUGIN_PATH_SEPARATOR',
  'PLUGIN_ABSOLUTE_PATH',
  'PLUGIN_CONTROL_CHAR',
  'PLUGIN_NOT_NFC',
  'PLUGIN_DUPLICATE_ENTRY',
  'PLUGIN_DIRECTORY_ENTRY',
  'PLUGIN_SYMLINK',
  'PLUGIN_ZIP64',
  'PLUGIN_DATA_DESCRIPTOR',
  'PLUGIN_TRAILING_DATA',
  'PLUGIN_ARCHIVE_COMMENT',
  'PLUGIN_ENCRYPTED',
  'PLUGIN_COMPRESSION_METHOD',
  'PLUGIN_MALFORMED_ARCHIVE',
  'PLUGIN_BAD_MANIFEST',
  'PLUGIN_BAD_LOGO',
]);

const TOO_LARGE_CODES = new Set(['PLUGIN_TOO_LARGE', 'PLUGIN_RATIO', 'PLUGIN_MANIFEST_TOO_LARGE']);

/** `data`-tier manifest carrying a process-only field (`archive/refusal-codes.ts`) — one message covers the family. */
const DATA_TIER_CODES = new Set([
  'PLUGIN_DATA_HAS_FILES',
  'PLUGIN_DATA_HAS_ROUTES',
  'PLUGIN_DATA_HAS_DATABASE',
  'PLUGIN_DATA_HAS_JOBS',
  'PLUGIN_DATA_HAS_INGEST_ROOTS',
  'PLUGIN_DATA_HAS_MEMORY_MB',
  'PLUGIN_DATA_HAS_RUNTIME',
  'PLUGIN_DATA_HAS_PERMISSIONS',
  'PLUGIN_DATA_HAS_CHECKLIST',
]);

/**
 * One i18n key per refusal-code family — never the backend `detail` string, which
 * is log/debug text only (see `archive/refusal-codes.ts`'s own doc comment). A code
 * this map doesn't know yet (a future guard) falls back to a generic message that
 * still carries the raw `code`, since the code itself — unlike `detail` — is the
 * stable, safe-to-surface contract.
 */
export function refusalMessageKey(code: string | undefined): string {
  if (code && MALFORMED_CODES.has(code)) return 'settings.plugins.consent.refusal.malformed';
  if (code && TOO_LARGE_CODES.has(code)) return 'settings.plugins.consent.refusal.too_large';
  if (code && DATA_TIER_CODES.has(code)) return 'settings.plugins.consent.refusal.data_tier_field';
  switch (code) {
    case 'PLUGIN_BAD_SIGNATURE':
      return 'settings.plugins.consent.refusal.bad_signature';
    case 'PLUGIN_UNSIGNED':
      return 'settings.plugins.consent.refusal.unsigned_process';
    case 'PLUGIN_HASH_MISMATCH':
      return 'settings.plugins.consent.refusal.hash_mismatch';
    case 'PLUGIN_FILE_SET_MISMATCH':
      return 'settings.plugins.consent.refusal.file_set_mismatch';
    case 'PLUGIN_TIER_VIOLATION':
      return 'settings.plugins.consent.refusal.tier_violation';
    default:
      return 'settings.plugins.consent.refusal.unknown';
  }
}
