import { Injectable, inject, DestroyRef } from '@angular/core';
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
    if (this.tv.isTv()) this.bind();
  }

  private bind() {
    if (this.bound || typeof window === 'undefined') return;
    this.bound = true;
    const handler = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener('keydown', handler, { capture: true });
    this.destroyRef.onDestroy(() => window.removeEventListener('keydown', handler, { capture: true } as any));
  }

  private onKey(e: KeyboardEvent) {
    const dir = ARROW_TO_DIR[e.key];
    if (!dir) return;
    // Skip if focus is inside a text input — let the input handle caret movement
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement as HTMLElement | null)?.isContentEditable) {
      return;
    }
    // Skip while the immersive player owns the keyboard (it handles ArrowLeft/Right
    // for seek, ArrowUp/Down for volume, etc.)
    if (document.body.classList.contains('immersive')) return;
    const next = this.findNeighbor(dir);
    if (next) {
      e.preventDefault();
      next.focus({ preventScroll: false });
    }
  }

  private findNeighbor(dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null {
    const active = document.activeElement as HTMLElement | null;
    const all = collectFocusables();
    if (!all.length) return null;

    if (!active || active === document.body) {
      return all[0] ?? null;
    }

    const fromRect = active.getBoundingClientRect();
    const fromCx = fromRect.left + fromRect.width / 2;
    const fromCy = fromRect.top + fromRect.height / 2;
    const horizontal = dir === 'left' || dir === 'right';

    // Two-pass selection: first try elements that overlap the source axis range
    // (i.e. are visually "in line" with the current focus). Only fall back to a
    // weighted score if nothing in the same row/column qualifies. This gives D-pad
    // behavior matching what users expect on TV: Right always goes to the *next*
    // element in the same row, never diagonally jumps to another row.
    const inLine: { el: HTMLElement; primary: number }[] = [];
    const offLine: { el: HTMLElement; score: number }[] = [];

    for (const el of all) {
      if (el === active) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Skip elements that are visually unreachable (offscreen, pointer-events-none)
      if (getComputedStyle(el).pointerEvents === 'none') continue;

      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = cx - fromCx;
      const dy = cy - fromCy;

      // Filter by direction (with a 4px dead-zone for sub-pixel jitter)
      switch (dir) {
        case 'left':  if (dx >= -4) continue; break;
        case 'right': if (dx <=  4) continue; break;
        case 'up':    if (dy >= -4) continue; break;
        case 'down':  if (dy <=  4) continue; break;
      }

      // "In line" = candidate's box overlaps the source's perpendicular axis.
      // For horizontal nav: candidate's vertical extent overlaps source's vertical extent.
      const sameRowOrCol = horizontal
        ? (r.top < fromRect.bottom && r.bottom > fromRect.top)
        : (r.left < fromRect.right && r.right > fromRect.left);

      const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
      const cross   = horizontal ? Math.abs(dy) : Math.abs(dx);

      if (sameRowOrCol) {
        inLine.push({ el, primary });
      } else {
        // Constrain off-line candidates to a 45° cone (cross < primary) so we
        // don't snap to a button far in cross-axis direction
        if (cross > primary) continue;
        // Heavy cross-axis penalty so an off-line candidate only wins if it's
        // closer than any in-line option (which there are none in this branch).
        offLine.push({ el, score: primary * primary + 16 * cross * cross });
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
    return null;
  }
}

const ARROW_TO_DIR: Record<string, 'left' | 'right' | 'up' | 'down' | undefined> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [data-tv-focusable]';

function collectFocusables(): HTMLElement[] {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const visible = nodes.filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
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
