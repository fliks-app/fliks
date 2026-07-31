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
