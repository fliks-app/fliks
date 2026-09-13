/**
 * Home and a library page sliding over each other, the way a native stack does.
 *
 * The slide belongs to the gesture, not to the route pair. A surface that puts a
 * page on top of another arms it; chrome that switches root — the rail, and the
 * dock behind it — puts the stack back down. Deciding it from the routes alone
 * would owe every one of those surfaces an exception of its own, and the way
 * back would slide out of a page nothing ever slid into.
 */
import { Capacitor } from '@capacitor/core';
import { classUntilDone, leafRoutePath, type RouteNode } from './view-transition';

/** The app shells are the only places a stack is what the viewer is holding. In
 *  a browser tab, and in the desktop window, a page that slides in from the edge
 *  reads against the back button that is already there. */
const NATIVE_SHELL = Capacitor.isNativePlatform();

const HOME_ROUTE = '';
const LIBRARY_ROUTE = 'libraries/:libraryName';

type Direction = 'push' | 'pop';

const DIRECTION_CLASS: Record<Direction, string> = { push: 'vt-push', pop: 'vt-pop' };
/** Carries what the two directions share, so the CSS says once what does not
 *  depend on which way the pages are going. */
const SLIDE_CLASS = 'vt-slide';
/** Only a docked rail stays out of the slide; parked off-canvas it belongs to
 *  the page it is part of, and capturing it there leaves a hole the width of
 *  itself in front of the arriving page. */
const RAIL_CLASS = 'vt-rail-docked';
/** A rail captured apart from the pages is a veil over nothing, so it borrows
 *  the picture they took with them. Claimed only when there is one to borrow. */
const BACKDROP_CLASS = 'vt-backdrop-held';
const RAIL_PROPERTY = '--vt-rail';
/** Published by the app backdrop, the one place that knows which picture is on
 *  screen and that it has decoded. */
const BACKDROP_PROPERTY = '--app-bg-image';

/** The click being handled stacks a page. Consumed by the navigation it starts,
 *  so it can never outlive the gesture that set it. */
let armed = false;
/** A slide put the page on screen on top of home, i.e. leaving it is a pop. */
let stacked = false;

export function armPageSlide(): void {
  armed = true;
}

export function resetPageSlide(): void {
  armed = false;
  stacked = false;
}

/** Which half of the slide this navigation is, if any. Consumes the arming. */
export function nextSlide(from: RouteNode, to: RouteNode): Direction | null {
  const arming = armed;
  armed = false;
  if (arming && leafRoutePath(from) === HOME_ROUTE && leafRoutePath(to) === LIBRARY_ROUTE) {
    stacked = true;
    return 'push';
  }
  if (stacked && leafRoutePath(from) === LIBRARY_ROUTE && leafRoutePath(to) === HOME_ROUTE) {
    stacked = false;
    return 'pop';
  }
  return null;
}

/** Where the docked rail ends, which is the inset that keeps the slide off it.
 *  Read from the live rail rather than from the breakpoint that docks it: closed,
 *  it is parked off-canvas and its right edge is 0, the inset that changes
 *  nothing. */
function railWidth(): number {
  const rail = document.querySelector('.app-chrome-side');
  return rail ? Math.max(0, Math.round(rail.getBoundingClientRect().right)) : 0;
}

function hasBackdrop(): boolean {
  const picture = getComputedStyle(document.documentElement)
    .getPropertyValue(BACKDROP_PROPERTY)
    .trim();
  return !!picture && picture !== 'none';
}

export function runPageSlide(
  transition: { finished: Promise<unknown> },
  from: RouteNode,
  to: RouteNode,
): void {
  if (!NATIVE_SHELL) return;
  const direction = nextSlide(from, to);
  if (!direction) return;
  const rail = railWidth();
  document.documentElement.style.setProperty(RAIL_PROPERTY, `${rail}px`);
  const classes = [SLIDE_CLASS, DIRECTION_CLASS[direction]];
  if (rail) {
    classes.push(RAIL_CLASS);
    if (hasBackdrop()) classes.push(BACKDROP_CLASS);
  }
  classUntilDone(transition, ...classes);
}
