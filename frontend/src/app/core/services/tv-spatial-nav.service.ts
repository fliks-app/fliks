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

    let best: HTMLElement | null = null;
    let bestScore = Infinity;

    for (const el of all) {
      if (el === active) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = cx - fromCx;
      const dy = cy - fromCy;

      // Filter to elements in the requested half-plane (with a small dead-zone)
      switch (dir) {
        case 'left':  if (dx >= -4) continue; break;
        case 'right': if (dx <=  4) continue; break;
        case 'up':    if (dy >= -4) continue; break;
        case 'down':  if (dy <=  4) continue; break;
      }

      const primary = (dir === 'left' || dir === 'right') ? Math.abs(dx) : Math.abs(dy);
      const cross   = (dir === 'left' || dir === 'right') ? Math.abs(dy) : Math.abs(dx);
      // Cross-axis weighted heavier so we prefer elements aligned with current row/column
      const score = primary * primary + 4 * cross * cross;

      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
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
  return nodes.filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  });
}
