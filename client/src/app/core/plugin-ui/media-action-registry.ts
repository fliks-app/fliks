/**
 * Closed catalogue of `media.actions` actionIds core implements. A plugin's
 * contribution to this slot may only reference one of these — it never ships
 * its own handler (per the plan's "no plugin ships Angular" rule).
 */
export type CoreMediaActionId =
  | 'media.recommend'
  | 'media.toggle-series-watched'
  | 'media.open-tracking'
  | 'media.request'
  | 'media.grab-best'
  | 'media.search-releases'
  | 'media.edit-profiles'
  | 'media.edit-library'
  | 'media.edit-subtitles'
  | 'media.refresh-metadata'
  | 'media.analyze'
  | 'media.toggle-monitored'
  | 'media.delete'
  | 'media.request-deletion';

const CORE_MEDIA_ACTION_IDS: ReadonlySet<string> = new Set<CoreMediaActionId>([
  'media.recommend',
  'media.toggle-series-watched',
  'media.open-tracking',
  'media.request',
  'media.grab-best',
  'media.search-releases',
  'media.edit-profiles',
  'media.edit-library',
  'media.edit-subtitles',
  'media.refresh-metadata',
  'media.analyze',
  'media.toggle-monitored',
  'media.delete',
  'media.request-deletion',
]);

/** One concrete handler per core actionId, supplied by whatever component owns the click. */
export type MediaActionHandlers = Record<CoreMediaActionId, () => void>;

/**
 * Resolves a contribution's `actionId` to the handler that implements it.
 * Anything outside the closed catalogue — a typo, a future id, a plugin
 * guessing — returns `null`. Fail closed: the caller must render no row at
 * all, never a button whose click silently does nothing.
 */
export function resolveMediaAction(
  actionId: string,
  handlers: MediaActionHandlers,
): (() => void) | null {
  return CORE_MEDIA_ACTION_IDS.has(actionId) ? handlers[actionId as CoreMediaActionId] : null;
}
