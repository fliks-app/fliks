/**
 * Poster morph between a media card and the media page.
 *
 * The stamp has to survive past the click: the browser snapshots on the next
 * tick, and the back transition reads it again, so it is never cleared on a
 * timer, only replaced. That makes a stale stamp the hazard, and the router's
 * transition hook drops it once neither side of a navigation has a poster.
 */
/** The clicked card's badges and progress bar, captured as one layer. */
export const CARD_OVERLAY_NAME = 'media-card-overlay';
/**
 * Marks what this module put there. A media page names its own hero the same
 * way — a style binding is an inline style too — and Angular does not rewrite
 * a binding whose value has not changed, so clearing by inline style took that
 * name away for good on a page kept in the route cache: the trip back then
 * found nothing to pair the card with.
 */
const STAMPED = 'data-poster-stamped';

export function clearPosterStamps(): void {
  document.querySelectorAll<HTMLElement>(`[${STAMPED}]`).forEach((el) => {
    el.style.viewTransitionName = '';
    el.removeAttribute(STAMPED);
  });
}

export function stampPoster(
  img: HTMLElement,
  mediaId: number,
  episodeId?: number | null,
  overlay?: HTMLElement | null,
): void {
  clearPosterStamps();
  // An episode page shows a still, not the series poster, so it pairs on its
  // own name: the series name would morph the card into the wrong image.
  img.style.viewTransitionName = episodeId
    ? `media-poster-ep-${episodeId}`
    : `media-poster-${mediaId}`;
  img.setAttribute(STAMPED, '');
  // The morphing poster is painted above the page snapshot, so the card's own
  // badges only reappear when the animation ends unless they are lifted too.
  if (overlay) {
    overlay.style.viewTransitionName = CARD_OVERLAY_NAME;
    overlay.setAttribute(STAMPED, '');
  }
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

/** The player pairs with nothing — it has no poster, and its own close animation
 *  owns the swap — so neither poster trip may claim a trip to or from it. */
export const WATCH_PATH = 'watch/:mediaFileId';

/** Router hands the transition hook the ROOT snapshots, whose routeConfig is null. */
export function leafRoutePath(root: RouteNode): string | undefined {
  let leaf = root;
  while (leaf.firstChild) leaf = leaf.firstChild;
  return leaf.routeConfig?.path;
}

/** A card opening the page that carries the other half of its morph. */
export function enteringPosterPage(from: RouteNode, to: RouteNode): boolean {
  return (
    POSTER_ROUTES.has(leafRoutePath(to)) &&
    !POSTER_ROUTES.has(leafRoutePath(from)) &&
    leafRoutePath(from) !== WATCH_PATH
  );
}

/** The way back: the page that owns the hero returns to a list of cards. */
export function leavingPosterPage(from: RouteNode, to: RouteNode): boolean {
  return (
    POSTER_ROUTES.has(leafRoutePath(from)) &&
    !POSTER_ROUTES.has(leafRoutePath(to)) &&
    leafRoutePath(to) !== WATCH_PATH
  );
}

/**
 * Drop a stamp left over from an earlier card click when neither side of the
 * navigation has a poster to pair with: the lone img would be snapshotted out of
 * the figure that rounds it and animate on its own.
 */
export function clearStalePosterStamps(from: RouteNode, to: RouteNode): void {
  const player =
    leafRoutePath(from) === WATCH_PATH || leafRoutePath(to) === WATCH_PATH;
  const pairs =
    POSTER_ROUTES.has(leafRoutePath(from)) || POSTER_ROUTES.has(leafRoutePath(to));
  if (!player && pairs) return;
  clearPosterStamps();
}

const VIEW_TRANSITION_CLASS = 'view-transitioning';

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

let swipeBack = false;

/** A swipe-back is animated natively, under an opaque snapshot of the page
 *  being left: the web transition would run unseen and outlast the slide. */
export function setSwipeBackActive(active: boolean): void {
  swipeBack = active;
}

export function swipeBackActive(): boolean {
  return swipeBack;
}
