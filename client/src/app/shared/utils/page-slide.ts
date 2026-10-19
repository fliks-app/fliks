/** Pages sliding over each other like a native stack. The slide belongs to the gesture, not the route pair: a surface arms it,
 *  chrome that switches root (rail, dock) puts the stack back down. Only phones stack: the dock renders there alone, so it is the device test. */
import { Capacitor } from '@capacitor/core';
import {
  WATCH_PATH,
  classUntilDone,
  leafRoutePath,
  leavingPosterPage,
  type RouteNode,
} from './view-transition';

/** Only app shells hold a stack; in a browser tab or desktop window an edge slide fights the existing back button. */
const NATIVE_SHELL = Capacitor.isNativePlatform();

export type Direction = 'push' | 'pop';

const DIRECTION_CLASS: Record<Direction, string> = { push: 'vt-push', pop: 'vt-pop' };
/** Carries what the two directions share, so the CSS says once what does not
 *  depend on which way the pages are going. */
const SLIDE_CLASS = 'vt-slide';
/** Bottom chrome held still for a slide within one tab: translucent travelling copies would show through each other. */
const CHROME_CLASS = 'vt-chrome-held';
/** Put on the document by NavbarService for the length of a back navigation —
 *  read here rather than re-deriving which triggers count as one. */
const BACK_CLASS = 'nav-back';

/** The click being handled stacks a page. Consumed by the navigation it starts,
 *  so it can never outlive the gesture that set it. */
let armed = false;
/** How many pages the slide has stacked, so only as many trips back pop. */
let stacked = 0;

export function armPageSlide(): void {
  armed = true;
}

/** Takes the arming for the navigation now starting. Called once, up front —
 *  before any guard can return early and strand it for a navigation that never asked for it. */
export function consumeArmed(): boolean {
  const wasArmed = armed;
  armed = false;
  return wasArmed;
}

/** A root entry starts from an empty stack: the rail and the dock switch root
 *  rather than stacking a page, so nothing they open ever owes a pop. */
export function resetStack(): void {
  stacked = 0;
}

/** Whether this navigation is a trip back, per the class NavbarService puts on
 *  the document for the length of one. */
export function goingBack(): boolean {
  return document.documentElement.classList.contains(BACK_CLASS);
}

/** Which half of the slide this navigation is, if any. `armed` is the single {@link consumeArmed} result (a guard may have spent it);
 *  `morphed` pairs stack a page but neither animate nor spend a pop, since the morph owns that trip. */
export function nextSlide(
  from: RouteNode,
  to: RouteNode,
  armed: boolean,
  morphed = false,
): Direction | null {
  // The player covers the whole screen and animates its own open and close.
  if (leafRoutePath(from) === WATCH_PATH || leafRoutePath(to) === WATCH_PATH) return null;
  if (morphed) return null;
  // Asked before the arming: a tap that never navigated — a scroll or a
  // long press started on a card — must not turn the way back around.
  if (goingBack()) {
    if (stacked === 0) return null;
    stacked--;
    return 'pop';
  }
  if (armed) return 'push';
  return null;
}

/** A push only earns a pop once its slide actually played — one skipped for
 *  want of a dock (e.g. keyboard open) must not owe a pop that never showed. */
export function confirmPush(slid: boolean): void {
  if (slid) stacked++;
}

/** Gives back a stacked page when nothing else will (swipe-back returns before {@link nextSlide}); skips morph pairs, never counted, and only when {@link goingBack}. */
export function releaseStackedPop(from: RouteNode, to: RouteNode): void {
  if (goingBack() && stacked > 0 && !leavingPosterPage(from, to)) stacked--;
}

/** Where the bottom chrome starts (FAB included); 0 without a dock, i.e. off phones. */
function dockInset(): number {
  const tops = ['.dock', '[data-chrome-fab]']
    .map((sel) => document.querySelector(sel)?.getBoundingClientRect().top)
    .filter((top): top is number => top !== undefined);
  return tops.length ? Math.max(0, Math.round(window.innerHeight - Math.min(...tops))) : 0;
}

/** Slide this navigation's pages over each other; returns whether it did, so a caller can drop an otherwise empty transition. */
/** Whether a stacked page would slide here at all. A pair the stack cannot
 *  animate has to be given back to whatever else can. */
export function pageSlideAvailable(): boolean {
  return NATIVE_SHELL && dockInset() > 0;
}

export function slidePage(
  transition: { finished: Promise<unknown> },
  direction: Direction,
): boolean {
  if (!pageSlideAvailable()) return false;
  classUntilDone(transition, SLIDE_CLASS, DIRECTION_CLASS[direction], CHROME_CLASS);
  return true;
}
