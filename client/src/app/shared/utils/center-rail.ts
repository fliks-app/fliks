/**
 * Centre a horizontal rail on one of its cards, addressed by element id. No-op
 * when the card isn't there or the rail doesn't overflow: nothing to scroll.
 */
export function centerRailOnCard(cardId: string): void {
  const card = document.getElementById(cardId);
  const rail = card?.parentElement;
  if (!card || !rail || rail.scrollWidth <= rail.clientWidth) return;
  const offset =
    card.getBoundingClientRect().left -
    rail.getBoundingClientRect().left +
    rail.scrollLeft -
    rail.clientWidth / 2 +
    card.offsetWidth / 2;
  rail.scrollTo({ left: Math.max(0, offset), behavior: 'smooth' });
}
