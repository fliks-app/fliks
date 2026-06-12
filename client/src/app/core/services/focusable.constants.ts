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
