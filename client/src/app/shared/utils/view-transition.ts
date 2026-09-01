/**
 * Poster morph between a media card and the media page.
 *
 * The stamp has to survive past the click: the browser snapshots on the next
 * tick, and the back transition reads it again, so it is never cleared on a
 * timer, only replaced. That makes a stale stamp the hazard, and the router's
 * transition hook drops it once neither side of a navigation has a poster.
 */
export function clearPosterStamps(except?: HTMLElement): void {
  document
    .querySelectorAll<HTMLElement>('img[style*="view-transition-name"]')
    .forEach((el) => {
      if (el !== except) el.style.viewTransitionName = '';
    });
}

export function stampPoster(
  img: HTMLElement,
  mediaId: number,
  episodeId?: number | null,
): void {
  clearPosterStamps(img);
  // An episode page shows a still, not the series poster, so it pairs on its
  // own name: the series name would morph the card into the wrong image.
  img.style.viewTransitionName = episodeId
    ? `media-poster-ep-${episodeId}`
    : `media-poster-${mediaId}`;
}

interface RouteNode {
  firstChild: RouteNode | null;
  routeConfig: { path?: string } | null;
}

/** Routes that carry a hero poster, i.e. the other half of a card's morph. */
const POSTER_ROUTES = new Set<string | undefined>([
  'movies/:id',
  'series/:id',
  'series/:id/episode/:episodeId',
]);

/** Router hands the transition hook the ROOT snapshots, whose routeConfig is null. */
export function leafRoutePath(root: RouteNode): string | undefined {
  let leaf = root;
  while (leaf.firstChild) leaf = leaf.firstChild;
  return leaf.routeConfig?.path;
}

/**
 * Drop a stamp left over from an earlier card click when neither side of the
 * navigation has a poster to pair with: the lone img would be snapshotted out of
 * the figure that rounds it and animate on its own.
 */
export function clearStalePosterStamps(from: RouteNode, to: RouteNode): void {
  if (POSTER_ROUTES.has(leafRoutePath(from)) || POSTER_ROUTES.has(leafRoutePath(to))) return;
  clearPosterStamps();
}

export const VIEW_TRANSITION_CLASS = 'view-transitioning';

/**
 * Flag the document for as long as the transition runs, so an entry animation
 * that would otherwise stack on top of the morph (see ImgFadeInDirective) can
 * sit it out.
 */
export function markViewTransition(transition: { finished: Promise<unknown> }): void {
  const root = document.documentElement;
  root.classList.add(VIEW_TRANSITION_CLASS);
  const done = () => root.classList.remove(VIEW_TRANSITION_CLASS);
  void transition.finished.then(done, done);
}

export function viewTransitionRunning(): boolean {
  return document.documentElement.classList.contains(VIEW_TRANSITION_CLASS);
}
