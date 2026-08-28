import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { ImageCacheService } from '../../core/services/image-cache.service';

/**
 * Drop-in replacement for `[src]` on server artwork: renders the on-disk copy
 * when native has one and fills the cache as images scroll past, so the grid
 * still has its posters offline. Pass-through on web.
 */
@Directive({ selector: 'img[cachedSrc]' })
export class CachedSrcDirective {
  readonly cachedSrc = input<string | null>();

  private readonly el: HTMLImageElement = inject(ElementRef).nativeElement;
  private readonly cache = inject(ImageCacheService);
  /** Guards against a slow resolve landing after a newer binding. */
  private seq = 0;

  constructor() {
    effect(() => {
      const url = this.cachedSrc();
      const token = ++this.seq;
      if (!url) {
        this.el.removeAttribute('src');
        return;
      }
      if (!this.cache.enabled) {
        this.el.setAttribute('src', url);
        return;
      }
      // Same frame when the cache can answer without the bridge: awaiting it
      // leaves a whole cold-start grid src-less for as long as the round-trip.
      const now = this.cache.resolveNow(url);
      if (now) {
        this.el.setAttribute('src', now);
        return;
      }
      void this.cache.resolve(url).then((resolved) => {
        if (token === this.seq) this.el.setAttribute('src', resolved);
      });
    });
  }
}
