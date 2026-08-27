/**
 * Closed catalogue of `media.actions` actionIds core implements. A plugin's
 * contribution to this slot may only reference one of these — it never ships
 * its own handler — plugins never ship their own Angular code.
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
  | 'media.toggle-like'
  | 'media.download'
  | 'media.play'
  | 'media.open'
  | 'media.add-to-playlist'
  | 'media.toggle-watched'
  | 'media.remove'
  | 'media.identify'
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
  'media.toggle-like',
  'media.download',
  'media.play',
  'media.open',
  'media.add-to-playlist',
  'media.toggle-watched',
  'media.remove',
  'media.identify',
  'media.analyze',
  'media.toggle-monitored',
  'media.delete',
  'media.request-deletion',
]);

/**
 * The handlers a surface supplies. Partial on purpose: the card menu and the
 * detail menu read one list of actions and each serves the subset it can, so an
 * id it has no handler for resolves to null and its row is dropped rather than
 * listed and inert.
 */
export type MediaActionHandlers = Partial<Record<CoreMediaActionId, () => void>>;

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
  if (!CORE_MEDIA_ACTION_IDS.has(actionId)) return null;
  return handlers[actionId as CoreMediaActionId] ?? null;
}
