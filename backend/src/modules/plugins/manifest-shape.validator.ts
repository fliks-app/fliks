import type { PluginManifest } from '../../common/plugin-contract';
import { refuse, type PluginRefusal } from './archive/refusal-codes';

export interface ManifestShapeSuccess {
  ok: true;
}
export type ManifestShapeResult = ManifestShapeSuccess | PluginRefusal;

const OK: ManifestShapeSuccess = { ok: true };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Only the fields a consumer actually reads (`deriveCapabilities`, the client) — not deep slot/action legality. */
function isWellShapedContribution(v: unknown): boolean {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.slot === 'string' &&
    typeof v.weight === 'number' &&
    typeof v.labelKey === 'string' &&
    isRecord(v.action) &&
    typeof v.action.kind === 'string'
  );
}

function isWellShapedField(v: unknown): boolean {
  return isRecord(v) && typeof v.key === 'string' && typeof v.type === 'string' && typeof v.labelKey === 'string';
}

/** Each `kind` carries its own required key: the client binds them without a guard. */
function isWellShapedConfigPage(v: unknown): boolean {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.labelKey !== 'string') return false;
  if (v.kind === 'table') return typeof v.list === 'string' && Array.isArray(v.columns);
  if (v.kind === 'providers') return typeof v.list === 'string' && typeof v.implementations === 'string';
  return Array.isArray(v.fields) && v.fields.every(isWellShapedField);
}

function isWellShapedEvent(v: unknown): boolean {
  return isRecord(v) && typeof v.event === 'string' && typeof v.webhook === 'string';
}

function isReleasePickerPair(v: unknown): boolean {
  return isRecord(v) && typeof v.search === 'string' && typeof v.grab === 'string';
}

/** Shape-checks the nested `ui` and `events` types, which `parseManifest` never looks inside.
 *  Both tiers declare them, and `deriveCapabilities` reads them before either is installed. */
export function validateManifestShape(manifest: PluginManifest): ManifestShapeResult {
  const ui = manifest.ui;
  if (ui !== undefined) {
    if (!isRecord(ui)) return refuse('PLUGIN_BAD_UI', 'manifest.ui must be an object');

    if (ui.contributions !== undefined && (!Array.isArray(ui.contributions) || !ui.contributions.every(isWellShapedContribution))) {
      return refuse('PLUGIN_BAD_UI_CONTRIBUTIONS', 'ui.contributions must be an array of {id, slot, weight, labelKey, action} entries');
    }

    if (ui.configPages !== undefined && (!Array.isArray(ui.configPages) || !ui.configPages.every(isWellShapedConfigPage))) {
      return refuse('PLUGIN_BAD_UI_CONFIG_PAGES', 'ui.configPages must be an array of pages carrying the keys their kind requires');
    }

    if (ui.releasePicker !== undefined) {
      const rp = ui.releasePicker as unknown;
      const shapeOk =
        isRecord(rp) && (['movie', 'season', 'episode'] as const).every((c) => isReleasePickerPair((rp as Record<string, unknown>)[c]));
      if (!shapeOk) {
        return refuse('PLUGIN_BAD_UI_RELEASE_PICKER', 'ui.releasePicker must declare {search, grab} routes for movie, season and episode');
      }
    }
  }

  if (manifest.events !== undefined && (!Array.isArray(manifest.events) || !manifest.events.every(isWellShapedEvent))) {
    return refuse('PLUGIN_BAD_EVENTS', 'events must be an array of {event, webhook} entries');
  }

  return OK;
}
