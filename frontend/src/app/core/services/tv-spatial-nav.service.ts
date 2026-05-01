import { Injectable, inject, DestroyRef, effect } from '@angular/core';
import { TvService } from './tv.service';

/**
 * Lightweight spatial navigation for D-pad input on Android TV.
 *
 * Listens globally for ArrowLeft/Right/Up/Down keys and moves focus to the
 * geometrically closest focusable element in that direction. Browsers don't
 * natively map arrows to focus changes (only Tab), so we wire it up ourselves.
 *
 * Algorithm: among visible focusable elements that lie in the requested direction
 * (relative to the current focus rect's center), pick the one minimizing
 *   distance²  =  primary-axis-gap² + α × cross-axis-misalignment²
 * with α tuned so that "stay in the same row/column" wins over jumps when
 * possible.
 */
@Injectable({ providedIn: 'root' })
export class TvSpatialNavService {
  private readonly tv = inject(TvService);
  private readonly destroyRef = inject(DestroyRef);
  private bound = false;

  constructor() {
    // Use an effect so we react to isTv flipping later (e.g. when TvService is
    // instantiated after us, or if detection is updated post-bootstrap).
    effect(() => {
      if (this.tv.isTv() && !this.bound) this.bind();
    });
  }

  private bind() {
    if (this.bound || typeof window === 'undefined') return;
    this.bound = true;
    const handler = (e: KeyboardEvent) => this.onKey(e);
    // Single listener on window (capture phase) — earlier we doubled up with
    // document AND window which made each keypress fire the handler twice and
    // skip every other card on horizontal nav.
    window.addEventListener('keydown', handler, { capture: true });
    this.destroyRef.onDestroy(() => window.removeEventListener('keydown', handler, { capture: true } as any));
    // Android TV WebView often leaves the body un-focused on first paint, which
    // means D-pad events are consumed by the native View and never reach JS.
    // Pushing focus to the first interactive element guarantees subsequent
    // keydowns are dispatched into our handler.
    queueMicrotask(() => this.focusFirstIfNoFocus());
  }

  private focusFirstIfNoFocus() {
    if (typeof document === 'undefined') return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const all = collectFocusables();
    all[0]?.focus({ preventScroll: true });
  }

  private onKey(e: KeyboardEvent) {
    // Some Android WebView builds don't report a `key` for D-pad events but
    // still ship `keyCode` 37/38/39/40 — accept either form.
    const dir = ARROW_TO_DIR[e.key] ?? KEYCODE_TO_DIR[e.keyCode];
    if (!dir) return;
    // Skip if focus is inside a text-style input — let it own caret movement.
    // Checkbox/radio/range have no caret, so spatial nav must keep handling
    // arrow keys for them (otherwise users get stuck on the toggle).
    const active = document.activeElement as HTMLElement | null;
    const tag = active?.tagName;
    const inputType = (active as HTMLInputElement | null)?.type;
    const isTextInput =
      tag === 'TEXTAREA' ||
      active?.isContentEditable ||
      (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit', 'reset'].includes(inputType ?? ''));
    if (isTextInput) {
      return;
    }
    // Skip on sliders (seekbar, volume) — they handle ArrowLeft/Right themselves
    // for value adjustment. role="slider" is the canonical signal; we also accept
    // an opt-out attribute for elements that own their own arrow handling.
    if (active?.matches('[role="slider"], [data-tv-skip-spatial], [data-tv-skip-spatial] *')) {
      return;
    }
    const next = this.findNeighbor(dir);
    // Always preventDefault on D-pad keys: the browser's default ArrowDown is
    // to scroll the page, which would push the focused card out of the
    // viewport while keeping focus on it (focus ring vanishes from view, the
    // user thinks the cursor disappeared). Whether or not we find a
    // neighbour, swallow the key so spatial nav fully owns D-pad behaviour.
    e.preventDefault();
    if (next) {
      next.focus({ preventScroll: false });
    }
  }

  private findNeighbor(dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null {
    const active = document.activeElement as HTMLElement | null;
    // Focus trap: any open dropdown/menu/bottom-sheet that opts in via
    // `[data-tv-modal]` (or `.dropdown-open .dropdown-content` for the
    // legacy player dropdowns) restricts navigation to its contents so
    // D-pad keys can't escape the modal.
    const openModal =
      document.querySelector<HTMLElement>('[data-tv-modal]') ??
      document.querySelector<HTMLElement>('.dropdown-open .dropdown-content');
    const all = openModal ? collectFocusables(openModal) : collectFocusables();
    if (!all.length) return null;

    if (!active || active === document.body) {
      return all[0] ?? null;
    }

    const fromRect = active.getBoundingClientRect();
    const fromCx = fromRect.left + fromRect.width / 2;
    const fromCy = fromRect.top + fromRect.height / 2;
    const horizontal = dir === 'left' || dir === 'right';

    // Scope horizontal nav to the active horizontal scroller (if any). Without
    // this, pressing Right on the last card of a row would fall through to
    // the `anywhere` fallback and land on a card from another row or a button
    // elsewhere. Inside a scroller, Left/Right should stay among siblings;
    // boundaries (first/last card) just block.
    const activeScroller = horizontal
      ? active.closest<HTMLElement>('.flex.overflow-x-auto, [data-scroller]')
      : null;

    // Three-pass selection:
    //   1. In-line: candidate's box overlaps the source's perpendicular axis
    //      (same row for horizontal nav, same column for vertical) → pick
    //      closest by primary distance. Matches user intent in 90% of cases.
    //   2. Off-line in 45° cone: nothing in the same row/col, take the
    //      closest candidate within 45° of the requested direction.
    //   3. Anything in the half-plane: last-resort fallback so the D-pad
    //      always finds *something* (e.g. reaching the top-left hamburger
    //      from a center button on a hero page would otherwise be stuck).
    const inLine: { el: HTMLElement; primary: number }[] = [];
    const offLine: { el: HTMLElement; score: number }[] = [];
    const anywhere: { el: HTMLElement; score: number }[] = [];

    for (const el of all) {
      if (el === active) continue;
      // Horizontal nav inside a scroller: candidates must be siblings in the
      // same scroller. At the last/first card the loop yields no candidates
      // and findNeighbor returns null — D-pad Right at end-of-row blocks
      // (no jump to a button on another row), matching TV remote convention.
      if (activeScroller && !activeScroller.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (getComputedStyle(el).pointerEvents === 'none') continue;

      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = cx - fromCx;
      const dy = cy - fromCy;

      switch (dir) {
        case 'left':  if (dx >= -4) continue; break;
        case 'right': if (dx <=  4) continue; break;
        case 'up':    if (dy >= -4) continue; break;
        case 'down':  if (dy <=  4) continue; break;
      }

      const sameRowOrCol = horizontal
        ? (r.top < fromRect.bottom && r.bottom > fromRect.top)
        : (r.left < fromRect.right && r.right > fromRect.left);
      const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
      const cross   = horizontal ? Math.abs(dy) : Math.abs(dx);

      if (sameRowOrCol) {
        inLine.push({ el, primary });
      } else if (cross <= primary) {
        offLine.push({ el, score: primary * primary + 16 * cross * cross });
      } else {
        // Last-resort: heavy cross-axis penalty, but still considered
        anywhere.push({ el, score: primary * primary + 64 * cross * cross });
      }
    }

    if (inLine.length) {
      inLine.sort((a, b) => a.primary - b.primary);
      return inLine[0].el;
    }
    if (offLine.length) {
      offLine.sort((a, b) => a.score - b.score);
      return offLine[0].el;
    }
    if (anywhere.length) {
      anywhere.sort((a, b) => a.score - b.score);
      return anywhere[0].el;
    }
    return null;
  }
}

const ARROW_TO_DIR: Record<string, 'left' | 'right' | 'up' | 'down' | undefined> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

const KEYCODE_TO_DIR: Record<number, 'left' | 'right' | 'up' | 'down' | undefined> = {
  37: 'left',
  38: 'up',
  39: 'right',
  40: 'down',
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [data-tv-focusable]';

function collectFocusables(root: ParentNode = document): HTMLElement[] {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const visible = nodes.filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    // tabindex=-1 means "skip spatial nav". The FOCUSABLE_SELECTOR matches
    // anchors via `a[href]` independently of tabindex, so without this filter
    // a media-card's inner title/subtitle links (which we set tabindex=-1 on
    // TV) would still be picked up by the D-pad as separate focus targets.
    if (el.getAttribute('tabindex') === '-1') return false;
    // offsetParent is null when the element (or any ancestor) has display:none,
    // visibility:hidden, or is detached — covers the cases where a parent hides
    // a focusable child via class toggling without the child itself being hidden.
    if (el.offsetParent === null && el.tagName !== 'BODY') return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    // Reject focusables only when they're positioned entirely off-document —
    // not just scrolled out of view. DaisyUI's drawer-toggle checkbox lives
    // at left: -100% and would otherwise pollute spatial nav (Left key would
    // teleport focus into it). But cards scrolled off a horizontal row, or
    // page sections scrolled above the viewport on a long detail page, are
    // valid targets: focusing them makes the browser scroll them back into
    // view. Document coords (viewport rect + window scroll) stay positive
    // for scrolled-off content, and a horizontal-scroller's internal
    // scrollLeft reaches its hidden siblings, so allow either case.
    if (r.right <= 0 || r.bottom <= 0) {
      const inScroller = el.closest('.flex.overflow-x-auto, [data-scroller]');
      const docRight = r.right + window.scrollX;
      const docBottom = r.bottom + window.scrollY;
      if (!inScroller && (docRight <= 0 || docBottom <= 0)) return false;
    }
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  });
  // Keep only the outermost focusables: if an element has an ancestor that is
  // also focusable, treat the ancestor as the navigation target. Without this,
  // a card containing several inner buttons/links presents 5+ targets to spatial
  // nav and a "Right" key can land on an inner element instead of the next card.
  const set = new Set(visible);
  return visible.filter((el) => {
    let p = el.parentElement;
    while (p) {
      if (set.has(p)) return false;
      p = p.parentElement;
    }
    return true;
  });
}
