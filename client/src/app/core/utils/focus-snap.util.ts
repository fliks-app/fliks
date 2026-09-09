import { pageScrollOwner } from './page-scroll.util';

/**
 * Pull a card row to the top of the viewport when focus enters it from
 * outside — the spatial-nav default `focus()` scrolls instantly and drops the
 * user mid-row. Shared by `app-horizontal-scroller` and `[appTvRowSnap]`, the
 * two row flavours, so a fix lands on both.
 */
export function snapRowOnFocus(
  event: FocusEvent,
  host: HTMLElement,
  topOffset: number,
): void {
  const from = event.relatedTarget as Node | null;
  if (from && host.contains(from)) return;
  // Clicking a card focuses it too, and pulling the page under the cursor
  // mid-click is never wanted. Chromium 76 (Tizen) throws on the selector —
  // those builds are D-pad only, where every focus deserves the snap.
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
  // A page that owns its scroller cannot scroll the document, and its box need
  // not start at the viewport top (TV's navbar is static), so measure inside it.
  const owner = pageScrollOwner(host);
  const scrollEl = owner ?? document.scrollingElement ?? document.documentElement;
  const viewTop = owner ? owner.getBoundingClientRect().top : 0;
  const viewBottom = owner ? viewTop + owner.clientHeight : window.innerHeight;
  const rect = host.getBoundingClientRect();
  const currentTop = scrollEl.scrollTop ?? 0;
  // Already fully visible: the user is walking between visible rows.
  if (rect.top >= viewTop + topOffset && rect.bottom <= viewBottom) return;
  const targetTop = Math.max(0, currentTop + rect.top - viewTop - topOffset);
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
