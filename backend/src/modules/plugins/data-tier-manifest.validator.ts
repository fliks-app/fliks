import type { PluginManifest } from '../../common/plugin-contract';
import { refuse, type PluginRefusal, type PluginRefusalCode, BASE_KEYS } from './archive';

export interface DataTierValidationSuccess {
  ok: true;
}
export type DataTierValidationResult = DataTierValidationSuccess | PluginRefusal;

/** Process-only keys, each refused on `data` with its own code so the exact violation is nameable. */
const PROCESS_ONLY_KEY_CODES: [string, PluginRefusalCode][] = [
  ['files', 'PLUGIN_DATA_HAS_FILES'],
  ['routes', 'PLUGIN_DATA_HAS_ROUTES'],
  ['database', 'PLUGIN_DATA_HAS_DATABASE'],
  ['jobs', 'PLUGIN_DATA_HAS_JOBS'],
  ['ingestRoots', 'PLUGIN_DATA_HAS_INGEST_ROOTS'],
  ['memoryMb', 'PLUGIN_DATA_HAS_MEMORY_MB'],
  ['runtime', 'PLUGIN_DATA_HAS_RUNTIME'],
  ['permissions', 'PLUGIN_DATA_HAS_PERMISSIONS'],
  ['checklist', 'PLUGIN_DATA_HAS_CHECKLIST'],
];

/** Runtime re-check of the `data` tier's field ban for a manifest that arrived as JSON.
 *  A no-op on `process`. */
export function validateDataTierManifest(manifest: PluginManifest): DataTierValidationResult {
  if (manifest.kind !== 'data') return { ok: true };

  const raw = manifest as unknown as Record<string, unknown>;
  for (const [key, code] of PROCESS_ONLY_KEY_CODES) {
    if (key in raw) return refuse(code, `a data-tier manifest may not declare "${key}"`);
  }
  for (const key of Object.keys(raw)) {
    if (!BASE_KEYS.has(key)) return refuse('PLUGIN_BAD_MANIFEST', `unknown top-level key "${key}"`);
  }
  return { ok: true };
}
