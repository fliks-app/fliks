/** Elements treated as focus targets by both spatial navigation and default focus; one place so the two agree.
 *  `[tabindex="-1"]` is an explicit opt-out; custom targets carry `tabindex="0"` or `[data-tv-focusable]`. */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [data-tv-focusable]';

/** Tab-cycle targets inside a trapped overlay (bottom sheet, dropdown menu). */
export const TABBABLE_SELECTOR =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Where focus lands when an overlay opens: the current-selection option, else the first tabbable.
 *  `aria-disabled` (from `SelectedOptionDirective`) keeps the current value in the focus order. */
/** Whether focus returns to the overlay's opener: only keyboard/D-pad (on touch it marks a control the user left, and iOS `<select>` reopens the picker). */
export function wantsFocusRestore(): boolean {
  if (typeof document === 'undefined') return false;
  const c = document.documentElement.classList;
  return c.contains('keyboard-modality') || c.contains('tv-host');
}

/** Settle focus after an overlay closes: keyboard/D-pad refocus the opener, touch blurs it (the backdrop deliberately doesn't blur). */
export function restoreOpenerFocus(opener: HTMLElement | null | undefined): void {
  if (!opener?.isConnected) return;
  if (wantsFocusRestore()) {
    opener.focus({ preventScroll: true });
    return;
  }
  if (document.activeElement === opener) opener.blur();
}

/** Markers of the current choice in a single-choice menu, strongest first.
 *  `aria-disabled` is what `SelectedOptionDirective` puts on the picked row. */
export const SELECTED_MARKERS = ['[aria-current="true"]', '[aria-disabled="true"]'];

/** Nearest ancestor that actually scrolls. Stops below `<body>` so the page behind
 *  an overlay is never moved. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const { overflowY } = getComputedStyle(n);
    if ((overflowY === 'auto' || overflowY === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

/** Center `el` in its own scroller below any sticky header unless fully visible; uses `scrollTop` since `scrollIntoView` can move the locked page. */
export function centerInScroller(el: HTMLElement | null | undefined): void {
  const box = el && scrollerOf(el);
  if (!el || !box || !box.clientHeight) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const sticky = [...box.children].find((c) => getComputedStyle(c).position === 'sticky');
  const top = b.top + box.clientTop + (sticky?.getBoundingClientRect().height ?? 0);
  const bottom = b.top + box.clientTop + box.clientHeight;
  if (r.top >= top && r.bottom <= bottom) return;
  const scale = b.height / box.clientHeight || 1;
  const delta = (r.top + r.bottom) / 2 - (top + bottom) / 2;
  box.scrollTo({ top: box.scrollTop + delta / scale, behavior: 'instant' });
}

/** Reveal the current choice of a freshly opened menu, without moving focus. */
export function scrollSelectedIntoView(root: ParentNode | null | undefined): void {
  for (const marker of SELECTED_MARKERS) {
    const el = root?.querySelector<HTMLElement>(marker);
    if (el) return centerInScroller(el);
  }
}

/** Focus an overlay entry and reveal it inside its own scroller: the entry is
 *  usually the current selection, which in a long list sits below the fold. */
export function focusOverlayEntry(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.focus({ preventScroll: true });
  centerInScroller(el);
}

export function initialOverlayFocus(root: ParentNode | null | undefined): HTMLElement | null {
  if (!root) return null;
  for (const marker of ['[autofocus]', ...SELECTED_MARKERS]) {
    const el = root.querySelector<HTMLElement>(marker);
    // Opt-out check only: this can run before layout, where a size check would always reject.
    if (el && !isFocusOptedOut(el)) return el;
  }
  return root.querySelector<HTMLElement>(TABBABLE_SELECTOR);
}

/** A horizontally scrolling rail: arrow keys stay inside one while stepping and its off-screen cards remain valid targets. */
export const SCROLLER_SELECTOR = '[data-scroller], .flex.overflow-x-auto';

/** Laid out and painted: not detached, zero-sized, hidden or display:none. */
export function isRendered(el: HTMLElement, style?: CSSStyleDeclaration): boolean {
  if (el.offsetParent === null && el.tagName !== 'BODY') return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const s = style ?? getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}

/** Whether focus may land on `el`; every skip rule lives here so the tree step, document scan and default focus can't drift.
 *  Pass `style` when already resolved to save a `getComputedStyle` per element. */
export function isFocusCandidate(
  el: HTMLElement,
  style?: CSSStyleDeclaration,
): boolean {
  return !isFocusOptedOut(el) && isRendered(el, style);
}

/** The opt-out half of {@link isFocusCandidate}, split out to stay testable. */
export function isFocusOptedOut(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  // `a[href]` matches regardless of tabindex, so a media-card's inner links
  // (tabindex=-1 on TV) would otherwise show up as separate targets.
  if (el.getAttribute('tabindex') === '-1') return true;
  // `[inert]` sections stay laid out and measure visible; `.modal-backdrop`'s full-viewport button would win every direction.
  return !!el.closest('[inert], .modal-backdrop');
}
