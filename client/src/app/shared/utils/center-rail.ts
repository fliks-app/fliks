/** Where each keyed rail was last scrolled to, by the viewer or by us, so a
 *  rail rebuilt by a navigation resumes from there instead of from the far left. */
const lastOffset = new Map<string, number>();
const tracked = new WeakSet<Element>();

/**
 * Centre a horizontal rail on one of its cards, addressed by element id. No-op
 * when the card isn't there or the rail doesn't overflow: nothing to scroll.
 *
 * `memoryKey` survives the rail's destruction. Navigating between two episodes
 * of a season rebuilds the rail at `scrollLeft: 0`, so without it the smooth
 * scroll below replays from the first episode every time.
 */
export function centerRailOnCard(cardId: string, memoryKey?: string): void {
  const card = document.getElementById(cardId);
  const rail = card?.parentElement;
  if (!card || !rail || rail.scrollWidth <= rail.clientWidth) return;
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
