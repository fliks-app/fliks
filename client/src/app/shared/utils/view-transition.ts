/** Poster morph between a media card and the media page. The stamp must outlive the click (snapshot on next tick, read again on back), so it is only replaced,
 * and the router hook drops it when neither side has a poster. */
/** The clicked card's badges and progress bar, captured as one layer. */
export const CARD_OVERLAY_NAME = 'media-card-overlay';
/** Marks what this module stamped: a hero's own style-bound name is unchanged so Angular won't rewrite it, and clearing by inline style would lose it in the route cache. */
const STAMPED = 'data-poster-stamped';

export function clearPosterStamps(): void {
  document.querySelectorAll<HTMLElement>(`[${STAMPED}]`).forEach((el) => {
    el.style.viewTransitionName = '';
    el.removeAttribute(STAMPED);
  });
}

/** Whether a card armed a morph for the navigation being started. */
export function hasPosterStamp(): boolean {
  return !!document.querySelector(`[${STAMPED}]`);
}

export function stampPoster(
  img: HTMLElement,
  mediaId: number,
  episodeId?: number | null,
  overlay?: HTMLElement | null,
): void {
  // An episode page shows a still, not the series poster, so it pairs on its
  // own name: the series name would morph the card into the wrong image.
  stampPosterNamed(
    img,
    episodeId ? `media-poster-ep-${episodeId}` : `media-poster-${mediaId}`,
    overlay,
  );
}

export function stampPosterNamed(
  img: HTMLElement,
  name: string,
  overlay?: HTMLElement | null,
): void {
  clearPosterStamps();
  img.style.viewTransitionName = name;
  img.setAttribute(STAMPED, '');
  // The morphing poster is painted above the page snapshot, so the card's own
  // badges only reappear when the animation ends unless they are lifted too.
  if (overlay) {
    overlay.style.viewTransitionName = CARD_OVERLAY_NAME;
    overlay.setAttribute(STAMPED, '');
  }
}

/** Hides the leaving hero for one transition: it is named for the opening morph and nothing on the destination carries that name.
 * Held by reference, so a page detached into the route cache still gets its name back. */
const HERO_MUTED = 'data-hero-muted';

export function muteHeroUntilDone(transition: { finished: Promise<unknown> }): void {
  const heroes = [
    ...document.querySelectorAll<HTMLElement>('app-media-info-header img'),
  ];
  heroes.forEach((el) => el.setAttribute(HERO_MUTED, ''));
  const done = () => heroes.forEach((el) => el.removeAttribute(HERO_MUTED));
  void transition.finished.then(done, done);
}

/** A provider id can equal a library id, so a preview page pairs on a name of its own. */
export function previewPosterName(type: string, provider: string, externalId: string): string {
  return `preview-poster-${type}-${provider}-${externalId}`;
}

export interface RouteNode {
  firstChild: RouteNode | null;
  routeConfig: { path?: string } | null;
}

/** Routes that carry a hero poster, i.e. the other half of a card's morph. */
const POSTER_ROUTES = new Set<string | undefined>([
  'movies/:id',
  'series/:id',
  'series/:id/episode/:episodeId',
  'add/movie/:provider/:externalId',
  'add/tv/:provider/:externalId',
  'add/movie/:tmdbId',
  'add/tv/:tmdbId',
  'parties/:id',
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

/** A list card opening the page with the other half of its morph; from a poster page the slide owns the pair. */
export function enteringPosterPage(from: RouteNode, to: RouteNode): boolean {
  return (
    POSTER_ROUTES.has(leafRoutePath(to)) &&
    !POSTER_ROUTES.has(leafRoutePath(from)) &&
    leafRoutePath(from) !== WATCH_PATH
  );
}

/** Two poster pages in a row: the stack slide owns that pair where it applies, the morph covers the rest. */
export function betweenPosterPages(from: RouteNode, to: RouteNode): boolean {
  return POSTER_ROUTES.has(leafRoutePath(from)) && POSTER_ROUTES.has(leafRoutePath(to));
}

/** The way back: the page that owns the hero returns to a list of cards. */
export function leavingPosterPage(from: RouteNode, to: RouteNode): boolean {
  return (
    POSTER_ROUTES.has(leafRoutePath(from)) &&
    !POSTER_ROUTES.has(leafRoutePath(to)) &&
    leafRoutePath(to) !== WATCH_PATH
  );
}

/** Drops a leftover stamp when neither side has a poster, else the lone img animates on its own out of its rounded figure. */
export function clearStalePosterStamps(from: RouteNode, to: RouteNode): void {
  const player =
    leafRoutePath(from) === WATCH_PATH || leafRoutePath(to) === WATCH_PATH;
  const pairs =
    POSTER_ROUTES.has(leafRoutePath(from)) || POSTER_ROUTES.has(leafRoutePath(to));
  if (!player && pairs) return;
  clearPosterStamps();
}

const VIEW_TRANSITION_CLASS = 'view-transitioning';

/** Flags the document while the transition runs so an entry animation (see ImgFadeInDirective) can sit it out. */
let running: Promise<void> = Promise.resolve();
let animating: object | null = null;

export function markViewTransition(transition: {
  ready?: Promise<unknown>;
  finished: Promise<unknown>;
}): void {
  const root = document.documentElement;
  root.classList.add(VIEW_TRANSITION_CLASS);
  void transition.ready?.then(() => (animating = transition), () => {});
  const done = () => {
    root.classList.remove(VIEW_TRANSITION_CLASS);
    if (animating === transition) animating = null;
  };
  running = transition.finished.then(done, done);
}

/** Between capture and the end of the animation: a captured element removed
 *  now makes the browser skip the whole transition. */
export function viewTransitionAnimating(): boolean {
  return animating !== null;
}

/** Settles once the running transition has. A navigation started before then
 *  starts a transition of its own, which skips the one on screen. */
export function viewTransitionDone(): Promise<void> {
  return running;
}

/** Count of running transitions per class: a superseded one cleans up after the new one named itself, so each takes back only its own. */
const heldClasses = new Map<string, number>();

/** Names the transition for the CSS that shapes it, for as long as it runs. */
export function classUntilDone(
  transition: { finished: Promise<unknown> },
  ...classes: string[]
): void {
  const root = document.documentElement;
  classes.forEach((cls) => heldClasses.set(cls, (heldClasses.get(cls) ?? 0) + 1));
  root.classList.add(...classes);
  const done = () =>
    classes.forEach((cls) => {
      const held = (heldClasses.get(cls) ?? 1) - 1;
      heldClasses.set(cls, held);
      if (held <= 0) root.classList.remove(cls);
    });
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
