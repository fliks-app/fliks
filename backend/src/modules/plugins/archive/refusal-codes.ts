/**
 * One code per archive guard (see `plans/plugin-system.plan.md`, "Guards,
 * ordered"). The code is the contract: a caller branches on it, never on
 * `detail`, which is log/debug text only.
 */
export type PluginRefusalCode =
  | 'PLUGIN_BAD_MAGIC'
  | 'PLUGIN_TOO_MANY_ENTRIES'
  | 'PLUGIN_UNEXPECTED_ENTRY'
  | 'PLUGIN_PATH_SEPARATOR'
  | 'PLUGIN_ABSOLUTE_PATH'
  | 'PLUGIN_CONTROL_CHAR'
  | 'PLUGIN_NOT_NFC'
  | 'PLUGIN_DUPLICATE_ENTRY'
  | 'PLUGIN_DIRECTORY_ENTRY'
  | 'PLUGIN_SYMLINK'
  | 'PLUGIN_ZIP64'
  | 'PLUGIN_DATA_DESCRIPTOR'
  | 'PLUGIN_TRAILING_DATA'
  | 'PLUGIN_ARCHIVE_COMMENT'
  | 'PLUGIN_ENCRYPTED'
  | 'PLUGIN_COMPRESSION_METHOD'
  | 'PLUGIN_TOO_LARGE'
  | 'PLUGIN_RATIO'
  | 'PLUGIN_MANIFEST_TOO_LARGE'
  | 'PLUGIN_BAD_SIGNATURE'
  | 'PLUGIN_UNSIGNED'
  | 'PLUGIN_HASH_MISMATCH'
  | 'PLUGIN_FILE_SET_MISMATCH'
  | 'PLUGIN_TIER_VIOLATION'
  | 'PLUGIN_BAD_MANIFEST'
  | 'PLUGIN_BAD_LOGO'
  /** `data`-tier manifest field bans (see `PluginManifestBase` deltas) — each
   *  names the process-only field it caught, so a refusal is attributable. */
  | 'PLUGIN_DATA_HAS_FILES'
  | 'PLUGIN_DATA_HAS_ROUTES'
  | 'PLUGIN_DATA_HAS_DATABASE'
  | 'PLUGIN_DATA_HAS_JOBS'
  | 'PLUGIN_DATA_HAS_INGEST_ROOTS'
  | 'PLUGIN_DATA_HAS_MEMORY_MB'
  | 'PLUGIN_DATA_HAS_RUNTIME'
  | 'PLUGIN_DATA_HAS_PERMISSIONS'
  | 'PLUGIN_DATA_HAS_CHECKLIST'
  /** yauzl refused the archive and no more specific guard claimed it. Never
   *  report a specific cause we did not actually establish. */
  | 'PLUGIN_MALFORMED_ARCHIVE';

export interface PluginRefusal {
  ok: false;
  code: PluginRefusalCode;
  detail: string;
}

export function refuse(code: PluginRefusalCode, detail: string): PluginRefusal {
  return { ok: false, code, detail };
}
