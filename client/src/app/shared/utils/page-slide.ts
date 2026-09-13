/**
 * Pages sliding over each other, the way a native stack does.
 *
 * The slide belongs to the gesture, not to the route pair. A surface that puts a
 * page on top of another arms it; chrome that switches root — the rail, and the
 * dock behind it — puts the stack back down. Deciding it from the routes alone
 * would owe every one of those surfaces an exception of its own, and the way
 * back would slide out of a page nothing ever slid into.
 *
 * A phone is the only form factor that stacks: the dock renders there and
 * nowhere else, so its presence is the whole device test, and holding it still
 * is what keeps the slide reading as one page over another rather than as the
 * whole app moving.
 */
import { Capacitor } from '@capacitor/core';
import { WATCH_PATH, classUntilDone, leafRoutePath, type RouteNode } from './view-transition';

/** The app shells are the only places a stack is what the viewer is holding. In
 *  a browser tab, and in the desktop window, a page that slides in from the edge
 *  reads against the back button that is already there. */
const NATIVE_SHELL = Capacitor.isNativePlatform();

export type Direction = 'push' | 'pop';

const DIRECTION_CLASS: Record<Direction, string> = { push: 'vt-push', pop: 'vt-pop' };
/** Carries what the two directions share, so the CSS says once what does not
 *  depend on which way the pages are going. */
const SLIDE_CLASS = 'vt-slide';
/** The shell's own bottom chrome, held still for a slide that stays inside one
 *  tab: the dock is the same box on both pages, and translucent, so travelling
 *  copies of it show through each other. */
const CHROME_CLASS = 'vt-chrome-held';
/** Put on the document by NavbarService for the length of a back navigation —
 *  read here rather than re-deriving which triggers count as one. */
const BACK_CLASS = 'nav-back';
const DOCK_PROPERTY = '--vt-dock';

/** The click being handled stacks a page. Consumed by the navigation it starts,
 *  so it can never outlive the gesture that set it. */
let armed = false;
/** How many pages the slide has stacked, so only as many trips back pop. */
let stacked = 0;

export function armPageSlide(): void {
  armed = true;
}

export function resetPageSlide(): void {
  armed = false;
  stacked = 0;
}

/** Whether this navigation is a trip back, per the class NavbarService puts on
 *  the document for the length of one. */
function goingBack(): boolean {
  return document.documentElement.classList.contains(BACK_CLASS);
}

/**
 * Which half of the slide this navigation is, if any. Consumes the arming, held
 * or not: one left behind would slide a later trip that never asked for it.
 *
 * `morphed` is a pair with a better animation of its own, in either direction.
 * It stacks a page all the same, but the stack neither animated it nor may
 * spend a pop on the way back: that trip is the morph's, and the page under it
 * is still one the slide put there.
 */
export function nextSlide(from: RouteNode, to: RouteNode, morphed = false): Direction | null {
  const arming = armed;
  armed = false;
  // The player covers the whole screen and animates its own open and close.
  if (leafRoutePath(from) === WATCH_PATH || leafRoutePath(to) === WATCH_PATH) return null;
  if (morphed) return null;
  if (arming) {
    stacked++;
    return 'push';
  }
  if (stacked > 0 && goingBack()) {
    stacked--;
    return 'pop';
  }
  return null;
}

/** Where the bottom chrome starts, the FAB standing out of its cradle
 *  included. 0 where there is no dock — which is every form factor but a
 *  phone, and the one test the slide needs. */
function dockInset(): number {
  const tops = ['.dock', '[data-chrome-fab]']
    .map((sel) => document.querySelector(sel)?.getBoundingClientRect().top)
    .filter((top): top is number => top !== undefined);
  return tops.length ? Math.max(0, Math.round(window.innerHeight - Math.min(...tops))) : 0;
}

/**
 * Slide the pages of this navigation over each other. Returns whether it did:
 * a caller with nothing else to animate drops the transition rather than run an
 * empty one.
 */
export function slidePage(
  transition: { finished: Promise<unknown> },
  direction: Direction,
): boolean {
  if (!NATIVE_SHELL) return false;
  const dock = dockInset();
  if (!dock) return false;
  document.documentElement.style.setProperty(DOCK_PROPERTY, `${dock}px`);
  classUntilDone(transition, SLIDE_CLASS, DIRECTION_CLASS[direction], CHROME_CLASS);
  return true;
}
