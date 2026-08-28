/**
 * Poster morph between a media card and the media page.
 *
 * The stamp has to survive past the click — the browser snapshots on the next
 * tick, and the back transition reads it again — so it is never cleared on a
 * timer, only replaced. That makes a stale stamp the hazard: a navigation
 * started from anything but a card would otherwise pair the destination poster
 * with whatever card was stamped last. Those callers clear it instead.
 */
export function clearPosterStamps(except?: HTMLElement): void {
  document
    .querySelectorAll<HTMLElement>('img[style*="view-transition-name"]')
    .forEach((el) => {
      if (el !== except) el.style.viewTransitionName = '';
    });
}

export function stampPoster(img: HTMLElement, mediaId: number): void {
  clearPosterStamps(img);
  img.style.viewTransitionName = `media-poster-${mediaId}`;
}
