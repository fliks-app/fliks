/**
 * One code per archive guard, in the order the guards run. The code is the
 * contract: a caller branches on it, never on `detail`, which is log/debug
 * text only.
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
  // One per nested section `parseManifest` does not look inside: the code names the section, so an
  // author learns what to fix without core surfacing `detail`.
  | 'PLUGIN_BAD_UI'
  | 'PLUGIN_BAD_UI_CONTRIBUTIONS'
  | 'PLUGIN_BAD_UI_CONFIG_PAGES'
  | 'PLUGIN_BAD_UI_RELEASE_PICKER'
  | 'PLUGIN_BAD_EVENTS'
  /** `id`/`version` are SQL identifiers and filesystem path segments downstream —
   *  validated once here so every later consumer can trust them unchecked. */
  | 'PLUGIN_BAD_ID'
  | 'PLUGIN_BAD_VERSION'
  | 'PLUGIN_BAD_LOGO'
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
