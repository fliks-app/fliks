import { Injectable, computed, effect, inject } from '@angular/core';
import { DeviceService, FormFactor } from './device.service';

export type PageScrollMode = 'container' | 'window';

const OVERRIDE_KEY = 'fliks.scrollModeOverride';

/**
 * Which scroll model each form factor gets when a route opts into owning its
 * scroll (`ownsScroll` route data). 'container' scrolls the route's own
 * element; 'window' leaves the document to scroll, so an in-flow chrome bar
 * (TV, desktop) leaves the screen with it instead of being stranded fixed
 * over a scroller it isn't part of. Edit this map to move a platform between
 * the two — every consumer reads {@link PageScrollModeService.mode}, never
 * `tv.isTv()` / `device.isDesktop()` directly.
 */
const MODE_BY_FORM_FACTOR: Record<FormFactor, PageScrollMode> = {
  phone: 'container',
  tablet: 'container',
  desktop: 'window',
  tv: 'window',
};

/** `?scroll=window|container` forces the mode without a rebuild, persisted so
 *  it survives in-app navigation — same pattern as `DeviceService`'s `?desktop=1`. */
function readOverride(): PageScrollMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get('scroll');
    if (forced === 'window' || forced === 'container') {
      window.localStorage.setItem(OVERRIDE_KEY, forced);
    } else if (params.has('reset-scroll')) {
      window.localStorage.removeItem(OVERRIDE_KEY);
    }
    const stored = window.localStorage.getItem(OVERRIDE_KEY);
    return stored === 'window' || stored === 'container' ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Single source of truth for "container or window?" so the platform test
 * lives in exactly one place instead of being re-derived at each call site.
 */
@Injectable({ providedIn: 'root' })
export class PageScrollModeService {
  private readonly device = inject(DeviceService);
  private readonly override = readOverride();

  readonly mode = computed<PageScrollMode>(
    () => this.override ?? MODE_BY_FORM_FACTOR[this.device.formFactor()],
  );

  /** Observable from outside Angular (CDP, visual QA) without reaching into component internals. */
  private readonly syncHtmlClass = effect(() => {
    if (typeof document === 'undefined') return;
    const isWindow = this.mode() === 'window';
    document.documentElement.classList.toggle('scroll-mode-window', isWindow);
    document.documentElement.classList.toggle('scroll-mode-container', !isWindow);
  });
}
