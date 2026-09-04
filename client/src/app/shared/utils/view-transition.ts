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

export function clearPosterStamps(): void {
  document
    .querySelectorAll<HTMLElement>(
      'img[style*="view-transition-name"], [data-card-overlay][style*="view-transition-name"]',
    )
    .forEach((el) => {
      el.style.viewTransitionName = '';
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
  // The morphing poster is painted above the page snapshot, so the card's own
  // badges only reappear when the animation ends unless they are lifted too.
  if (overlay) overlay.style.viewTransitionName = CARD_OVERLAY_NAME;
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

/**
 * The chrome the morph must not paint over, as insets the clip in `styles.css`
 * reads. Measured per trip: the sidebar is only docked at some widths, and the
 * dock only exists on a native phone.
 */
export function stampChromeInsets(): void {
  const side = document.querySelector('.app-chrome-side')?.getBoundingClientRect();
  const dock = document.querySelector('.dock')?.getBoundingClientRect();
  const style = document.documentElement.style;
  style.setProperty('--vt-chrome-left', `${Math.max(0, side?.right ?? 0)}px`);
  style.setProperty('--vt-chrome-bottom', `${dock ? Math.max(0, window.innerHeight - dock.top) : 0}px`);
}
