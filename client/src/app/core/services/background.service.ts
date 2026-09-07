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

  /** Pool the current pick came from. Used to detect equivalent
   *  calls so we don't re-randomise on every signal re-emit. */
  private pool: string[] = [];

  setBackground(url: string | null): void {
    this.pool = url ? [url] : [];
    this.url.set(url);
  }

  /**
   * Pick one image at random from `urls`. Re-calling with an
   * identical pool is a no-op so the displayed image doesn't
   * change while the user is on the page.
   */
  setBackgrounds(urls: string[]): void {
    const next = urls.filter((u): u is string => !!u);
    if (next.length === 0) {
      this.clear();
      return;
    }
    const samePool =
      next.length === this.pool.length &&
      next.every((u, i) => u === this.pool[i]);
    if (samePool) return;

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
