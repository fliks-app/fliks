/** The element whose focus is snapping its row this task: spatial nav then leaves the page scroll to the snap. */
let snapping: Element | null = null;

/** Pulls a card row to the top of the viewport when focus enters it from outside (spatial-nav's instant `focus()` scroll leaves the user mid-row);
 *  shared by `app-horizontal-scroller` and `[appTvRowSnap]`. */
export function snapRowOnFocus(
  event: FocusEvent,
  host: HTMLElement,
  topOffset: number,
): void {
  const from = event.relatedTarget as Node | null;
  if (from && host.contains(from)) return;
  // Skip on click (pulling the page mid-click is unwanted); Chromium 76 (Tizen) throws on the selector, but those builds are D-pad only.
  try {
    const target = event.target as HTMLElement | null;
    if (target && !target.matches(':focus-visible')) return;
  } catch {
    // No :focus-visible support: fall through and snap.
  }
  if (snapTarget(host, topOffset) === null) return;
  snapping = event.target as Element | null;
  queueMicrotask(() => {
    snapping = null;
    const top = snapTarget(host, topOffset);
    if (top !== null) scrollPageTo(top);
  });
}

/** Whether focusing `el`, in this task, snapped its row (the page scroll is then the snap's). */
export function rowSnapPending(el: Element): boolean {
  return snapping === el;
}

/** The page offset that puts `host` at `topOffset`, or null when it is already in view. */
function snapTarget(host: HTMLElement, topOffset: number): number | null {
  if (typeof window === 'undefined') return null;
  const scrollEl = document.scrollingElement ?? document.documentElement;
  const rect = host.getBoundingClientRect();
  const currentTop = scrollEl.scrollTop ?? 0;
  // Already fully visible: the user is walking between visible rows.
  if (rect.top >= topOffset && rect.bottom <= window.innerHeight) return null;
  const targetTop = Math.max(0, currentTop + rect.top - topOffset);
  return Math.abs(targetTop - currentTop) < 4 ? null : targetTop;
}

function scrollPageTo(top: number): void {
  const scrollEl = document.scrollingElement ?? document.documentElement;
  try {
    scrollEl.scrollTo({ top, left: 0, behavior: 'smooth' });
  } catch {
    scrollEl.scrollTo(0, top);
  }
}

/** Row top gap: TV clears the floating top-right dock, pointer UIs just breathe. */
export function rowTopOffset(isTv: boolean): number {
  return isTv ? 96 : 24;
}
