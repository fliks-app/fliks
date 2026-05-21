import { Injectable, signal } from '@angular/core';

/**
 * Global page-background image. Pages opt in by calling
 * `setBackground(url)`; the rendering layer (BackgroundComponent in
 * the root layout) listens to {@link url} and crossfades whenever it
 * changes. Pages that don't set a background see the default body
 * colour — there is no implicit fallback.
 *
 * Use cases:
 *  - media-detail: fanart of the current title
 *  - home: rotating posters/fanart from the library
 */
@Injectable({ providedIn: 'root' })
export class BackgroundService {
  /** Current target URL. `null` means "fade out, no background". */
  readonly url = signal<string | null>(null);

  setBackground(url: string | null): void {
    this.url.set(url);
  }

  clear(): void {
    this.url.set(null);
  }
}
