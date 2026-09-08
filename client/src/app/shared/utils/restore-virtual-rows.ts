/**
 * Lay a virtual viewport out for an offset the scroll is about to be restored
 * to, so a view transition that snapshots the page in between finds the rows
 * already there — otherwise the poster morph has no card to fly home to.
 *
 * The offset has to be real: CDK derives the rows AND their placement from it,
 * and a range set by hand against a scroll of 0 lands every row thousands of
 * pixels off screen. And it is kept, not handed back: the restore proper only
 * lands on the router's own scroll event a frame later, and CDK revisits its
 * range on the frame in between — from a scroll handed back to 0 it picks the
 * top of the list, throwing away every row on screen for the restore to build
 * again. On device that showed as the whole grid reloading its artwork and the
 * A-Z index reading `A` for a moment. The caller restores this same offset
 * immediately after, so keeping it is also where the page is headed.
 *
 * `flush` renders the range CDK has just chosen; the placement only lands in a
 * change-detection pass, and CDK asks for one rather than running it.
 */
export function renderRowsForOffset(
  viewport: { checkViewportSize(): void },
  offset: number,
  flush: () => void,
  scroller: Scroller = window,
): void {
  scroller.scrollTo({ top: offset, left: 0, behavior: 'instant' });
  viewport.checkViewportSize();
  flush();
}

interface Scroller {
  readonly scrollY: number;
  scrollTo(options: ScrollToOptions): void;
}
