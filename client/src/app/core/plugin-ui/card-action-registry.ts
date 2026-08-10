/**
 * Closed catalogue of `card.actions` actionIds core implements. A separate
 * namespace from `media-action-registry.ts`'s `media.actions` ids — the two
 * slots share no id and a card's handlers (open/play/dismiss, closed over a
 * single card's inputs) have nothing in common with a media-detail header's
 * (grab/delete/…), so one dispatcher for both would just blur two closed
 * catalogues that must never resolve each other's ids.
 */
export type CoreCardActionId =
  | 'card.play'
  | 'card.open'
  | 'card.add-to-playlist'
  | 'card.recommend'
  | 'card.toggle-watched'
  | 'card.remove';

const CORE_CARD_ACTION_IDS: ReadonlySet<string> = new Set<CoreCardActionId>([
  'card.play',
  'card.open',
  'card.add-to-playlist',
  'card.recommend',
  'card.toggle-watched',
  'card.remove',
]);

/** One concrete handler per core actionId, supplied by the card that owns the click. */
export type CardActionHandlers = Record<CoreCardActionId, () => void>;

/**
 * Resolves a contribution's `actionId` to the handler that implements it.
 * Anything outside the closed catalogue — a typo, a future id, a plugin
 * guessing — returns `null`. Fail closed: the caller must render no row at
 * all, never a button whose click silently does nothing.
 */
export function resolveCardAction(
  actionId: string,
  handlers: CardActionHandlers,
): (() => void) | null {
  return CORE_CARD_ACTION_IDS.has(actionId) ? handlers[actionId as CoreCardActionId] : null;
}
