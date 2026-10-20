/** Where each keyed rail was last scrolled to, by the viewer or by us, so a
 *  rail rebuilt by a navigation resumes from there instead of from the far left. */
const lastOffset = new Map<string, number>();
const tracked = new WeakSet<Element>();

/** Set on a rail a return has already placed; centring runs a frame later and would pull it off the card the reader left it on. */
export const RAIL_RESTORED_ATTR = 'data-rail-restored';

/** Centres a horizontal rail on a card by element id; no-op when the card is missing or the rail doesn't overflow.
 *  `memoryKey` survives the rail's destruction: navigating between episodes rebuilds it at `scrollLeft: 0`. */
export function centerRailOnCard(cardId: string, memoryKey?: string): void {
  const card = document.getElementById(cardId);
  const rail = card?.parentElement;
  if (!card || !rail || rail.scrollWidth <= rail.clientWidth) return;
  if (rail.hasAttribute(RAIL_RESTORED_ATTR)) return;
  if (memoryKey !== undefined && !tracked.has(rail)) {
    tracked.add(rail);
    const previous = lastOffset.get(memoryKey);
    if (previous) rail.scrollTo({ left: previous, behavior: 'instant' });
    rail.addEventListener('scroll', () => lastOffset.set(memoryKey, rail.scrollLeft), { passive: true });
  }
  const offset =
    card.getBoundingClientRect().left -
    rail.getBoundingClientRect().left +
    rail.scrollLeft -
    rail.clientWidth / 2 +
    card.offsetWidth / 2;
  rail.scrollTo({ left: Math.max(0, offset), behavior: 'smooth' });
}
