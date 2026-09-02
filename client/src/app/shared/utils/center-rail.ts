/** Last offset each keyed rail was centred at, so a rail rebuilt by a
 *  navigation resumes from there instead of from the far left. */
const lastOffset = new Map<string, number>();

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
  if (memoryKey !== undefined && rail.scrollLeft === 0) {
    const previous = lastOffset.get(memoryKey);
    if (previous) rail.scrollTo({ left: previous, behavior: 'instant' });
  }
  const offset =
    card.getBoundingClientRect().left -
    rail.getBoundingClientRect().left +
    rail.scrollLeft -
    rail.clientWidth / 2 +
    card.offsetWidth / 2;
  const target = Math.max(0, offset);
  if (memoryKey !== undefined) lastOffset.set(memoryKey, target);
  rail.scrollTo({ left: target, behavior: 'smooth' });
}
