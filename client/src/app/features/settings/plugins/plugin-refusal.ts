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

/** A nested manifest section `parseManifest` does not look inside — the code names which one, so
 *  the message can tell an author what to fix. */
const MANIFEST_SECTION_KEYS: Readonly<Record<string, string>> = {
  PLUGIN_BAD_UI: 'settings.plugins.consent.refusal.bad_ui',
  PLUGIN_BAD_UI_CONTRIBUTIONS: 'settings.plugins.consent.refusal.bad_ui_contributions',
  PLUGIN_BAD_UI_CONFIG_PAGES: 'settings.plugins.consent.refusal.bad_ui_config_pages',
  PLUGIN_BAD_UI_RELEASE_PICKER: 'settings.plugins.consent.refusal.bad_ui_release_picker',
  PLUGIN_BAD_EVENTS: 'settings.plugins.consent.refusal.bad_events',
};

/**
 * One i18n key per refusal-code family — never the backend `detail` string, which
 * is log/debug text only (see `archive/refusal-codes.ts`'s own doc comment). A code
 * this map doesn't know yet (a future guard) falls back to a generic message that
 * still carries the raw `code`, since the code itself — unlike `detail` — is the
 * stable, safe-to-surface contract.
 */
export function refusalMessageKey(code: string | undefined): string {
  if (code && MANIFEST_SECTION_KEYS[code]) return MANIFEST_SECTION_KEYS[code];
  if (code && MALFORMED_CODES.has(code)) return 'settings.plugins.consent.refusal.malformed';
  if (code && TOO_LARGE_CODES.has(code)) return 'settings.plugins.consent.refusal.too_large';
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
