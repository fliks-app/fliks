/**
 * The set of elements treated as focus targets by both spatial navigation
 * (D-pad / arrow keys) and the default-focus pass. Kept in one place so the two
 * agree — a divergence makes the default-focus landing differ from what the
 * first D-pad press then discovers, causing focus to jump.
 *
 * `[tabindex="-1"]` is excluded (explicit opt-out); media-card figures and other
 * custom targets carry `tabindex="0"` or `[data-tv-focusable]`.
 */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [data-tv-focusable]';

/** Tab-cycle targets inside a trapped overlay (bottom sheet, dropdown menu). */
export const TABBABLE_SELECTOR =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where focus lands when an overlay (bottom sheet, dropdown, popover) opens:
 * the option marking the current selection when there is one, otherwise the
 * first tabbable. The three markers below are the ones the app uses —
 * `aria-disabled` is set by `SelectedOptionDirective` (and is preferred over
 * `disabled` precisely so the current value stays in the focus order), while
 * `autofocus` and `aria-current` are set by hand at a few call sites.
 */
/**
 * Whether focus should be handed back to whatever opened an overlay. Only a
 * keyboard or a D-pad needs it: on touch it would mark a control the user is no
 * longer on, and refocusing a `<select>` on iOS reopens the native picker we
 * just replaced.
 */
export function wantsFocusRestore(): boolean {
  if (typeof document === 'undefined') return false;
  const b = document.body.classList;
  return b.contains('keyboard-modality') || b.contains('tv');
}

/**
 * Settle focus after an overlay closes. A keyboard or D-pad gets it back on the
 * opener, so the next Enter reopens it. Touch gets it taken off: the overlay
 * backdrop deliberately does not blur (that is what kept the ring from
 * flickering), so without this the opener kept a focus mark for a control the
 * user had already left. One rule for every overlay that closes.
 */
export function restoreOpenerFocus(opener: HTMLElement | null | undefined): void {
  if (!opener?.isConnected) return;
  if (wantsFocusRestore()) {
    opener.focus({ preventScroll: true });
    return;
  }
  if (document.activeElement === opener) opener.blur();
}

export function initialOverlayFocus(root: ParentNode | null | undefined): HTMLElement | null {
  if (!root) return null;
  for (const marker of ['[autofocus]', '[aria-current="true"]', '[aria-disabled="true"]']) {
    const el = root.querySelector<HTMLElement>(marker);
    // Only the opt-out half of isFocusCandidate: this can run before layout, so
    // a rendered-size check would always reject and fall through to the first
    // item.
    if (el && !isFocusOptedOut(el)) return el;
  }
  return root.querySelector<HTMLElement>(TABBABLE_SELECTOR);
}

/**
 * A horizontally scrolling rail. Arrow keys stay inside one while stepping,
 * and its off-screen cards remain valid targets.
 */
export const SCROLLER_SELECTOR = '[data-scroller], .flex.overflow-x-auto';

/** Laid out and painted: not detached, zero-sized, hidden or display:none. */
export function isRendered(el: HTMLElement, style?: CSSStyleDeclaration): boolean {
  if (el.offsetParent === null && el.tagName !== 'BODY') return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const s = style ?? getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}

/**
 * Whether focus may land on `el`. Every skip rule lives here so the passes
 * that hunt for a target — tree step, document scan, default focus — can't
 * drift apart; a new rule (`inert` was the last one) is added once.
 *
 * Pass `style` when the caller already resolved it, to save a second
 * `getComputedStyle` per element on a whole-document scan.
 */
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
  // A collapsed section keeps its content laid out, just inert: it measures
  // as visible but refuses focus, which dead-ends the move.
  return !!el.closest('[inert]');
}
