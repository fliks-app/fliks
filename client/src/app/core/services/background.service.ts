import { Injectable, signal } from '@angular/core';

/**
 * Global page-background image. Pages opt in by calling
 * `setBackground(url)` (single image) or `setBackgrounds(urls)`
 * (one random pick from the list). The BackgroundComponent at the
 * layout root listens to {@link url} and crossfades on change.
 *
 * The pick from `setBackgrounds` is stable: as long as the same
 * pool is passed back (e.g. when the media signal re-emits with
 * equal data), the chosen URL stays put — no flashing on every
 * change-detection cycle.
 */
@Injectable({ providedIn: 'root' })
export class BackgroundService {
  /** Current target URL. `null` means "fade out, no background".
   *
   *  Only an arriving page writes this. A page leaving does not blank it: the
   *  next one decides, and clearing on the way out would fade to nothing for as
   *  long as that page takes to load its own. */
  readonly url = signal<string | null>(null);

  /** Pool the pick came from, and the pick itself, so the same pool always
   *  yields the same image however many pages were visited in between. */
  private pool: string[] = [];
  private pick: string | null = null;

  setBackground(url: string | null): void {
    this.pool = url ? [url] : [];
    this.url.set(url);
  }

  /**
   * Pick one image at random from `urls`. The pick then holds for as long as
   * it stays in the pool, so a page keeps its image while its data streams in
   * and the pool grows underneath.
   */
  setBackgrounds(urls: string[]): void {
    const next = urls.filter((u): u is string => !!u);
    if (next.length === 0) {
      this.clear();
      return;
    }
    // The same pool gives back the image it already chose, even after a detour
    // through a page that showed its own: a return should restore what was
    // there, not roll again.
    if (this.pick && samePool(next, this.pool)) {
      this.url.set(this.pick);
      return;
    }
    // A pool that merely grew, as a page's data streams in, keeps the image it
    // is already showing rather than re-rolling on every instalment.
    const current = this.url();
    if (current && next.includes(current)) {
      this.pool = next;
      this.pick = current;
      return;
    }

    this.pool = next;
    this.pick = next[Math.floor(Math.random() * next.length)];
    this.url.set(this.pick);
  }

  /**
   * Apply a fanart pool, or clear when the user has page backgrounds off. The
   * pick stays stable for an unchanged pool, so a page holds the same image for
   * as long as the user is on it.
   */
  applyPool(pool: readonly string[], enabled: boolean): void {
    if (!enabled) {
      this.clear();
      return;
    }
    if (pool.length) this.setBackgrounds([...pool]);
  }

  clear(): void {
    this.pool = [];
    this.url.set(null);
  }
}

/** Pools are equal when they hold the same urls in the same order. */
function samePool(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((u, i) => u === b[i]);
}
