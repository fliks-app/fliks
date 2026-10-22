/** Closed catalogue of `media.actions` ids core implements; a plugin contribution may only reference one, never ship its own handler. */
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
  | 'media.download-series'
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
  'media.download-series',
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

/** Handlers a surface supplies; partial since card and detail menus each serve a subset, and an id without one is dropped. */
export type MediaActionHandlers = Partial<Record<CoreMediaActionId, () => void>>;

/** Resolves an `actionId` to its handler; anything outside the catalogue returns `null` (fail closed: no row, never an inert button). */
export function resolveMediaAction(
  actionId: string,
  handlers: MediaActionHandlers,
): (() => void) | null {
  if (!CORE_MEDIA_ACTION_IDS.has(actionId)) return null;
  return handlers[actionId as CoreMediaActionId] ?? null;
}
