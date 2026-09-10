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
  /** Current target URL. `null` means "fade out, no background". */
  readonly url = signal<string | null>(null);

  /** Pool the current pick came from, so a re-emit doesn't re-randomise. */
  private pool: string[] = [];

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
    // Keep the current pick while it is still on offer. The pool grows as a
    // page's data streams in, and re-rolling on every growth swaps the image
    // again within the same frame, which collapses the crossfade into a cut.
    const current = this.url();
    if (current && next.includes(current)) {
      this.pool = next;
      return;
    }

    this.pool = next;
    this.url.set(next[Math.floor(Math.random() * next.length)]);
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
