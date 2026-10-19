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
    // No :focus-visible support — fall through and snap.
  }
  queueMicrotask(() => snapToTop(host, topOffset));
}

function snapToTop(host: HTMLElement, topOffset: number): void {
  if (typeof window === 'undefined') return;
  const scrollEl = document.scrollingElement ?? document.documentElement;
  const rect = host.getBoundingClientRect();
  const currentTop = scrollEl.scrollTop ?? 0;
  // Already fully visible: the user is walking between visible rows.
  if (rect.top >= topOffset && rect.bottom <= window.innerHeight) return;
  const targetTop = Math.max(0, currentTop + rect.top - topOffset);
  if (Math.abs(targetTop - currentTop) < 4) return;
  try {
    scrollEl.scrollTo({ top: targetTop, left: 0, behavior: 'smooth' });
  } catch {
    scrollEl.scrollTo(0, targetTop);
  }
}

/** Row top gap: TV clears the floating top-right dock, pointer UIs just breathe. */
export function rowTopOffset(isTv: boolean): number {
  return isTv ? 96 : 24;
}
