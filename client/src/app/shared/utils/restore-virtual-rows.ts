/**
 * Lay a virtual viewport out for an offset the scroll is about to be restored
 * to, so a view transition that snapshots the page in between finds the rows
 * already there — otherwise the poster morph has no card to fly home to.
 *
 * The offset has to be real: CDK derives the rows AND their placement from it,
 * and a range set by hand against a scroll of 0 lands every row thousands of
 * pixels off screen. It also has to be given straight back — this runs before
 * the transition has captured the page it is leaving, so a scroll left behind
 * shows as that page jumping to its end. The rows survive the round trip
 * because CDK only revisits the range on its next frame, by which time the
 * restore proper has landed.
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
  const held = scroller.scrollY;
  scroller.scrollTo({ top: offset, left: 0, behavior: 'instant' });
  viewport.checkViewportSize();
  flush();
  scroller.scrollTo({ top: held, left: 0, behavior: 'instant' });
}

interface Scroller {
  readonly scrollY: number;
  scrollTo(options: ScrollToOptions): void;
}
