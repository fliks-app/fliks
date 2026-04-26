import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

/**
 * Detects whether the app is running on Android TV (or another leanback / 10-foot UI device)
 * and exposes a reactive signal so layouts and components can adapt.
 *
 * Detection sources, in order of confidence:
 * 1. Native UI mode (Android `Configuration.UI_MODE_TYPE_TELEVISION`) — MainActivity
 *    appends `AndroidTV/1` to the WebView user-agent in this case.
 * 2. CSS media query `(pointer: none)` — TVs typically have no pointer (only D-pad).
 * 3. User-agent sniffing for "Android TV", "BRAVIA", "SHIELD", "Aft" (Fire TV).
 *
 * Toggling the body `tv` class lets global Tailwind variants drive 10-foot UI adjustments
 * (focus rings, larger fonts, spacing) without each component branching on the signal.
 */
@Injectable({ providedIn: 'root' })
export class TvService {
  readonly isTv = signal(false);

  constructor() {
    // Source of truth = the `tv` body class set by main.ts before bootstrap.
    // This keeps detection consistent across services even when the heuristic
    // evolves: change main.ts and every consumer (TvSpatialNav, CardActions, …)
    // sees the new result.
    const fromBootstrap =
      typeof document !== 'undefined' && document.body.classList.contains('tv');
    const tv = fromBootstrap || this.detect();
    this.isTv.set(tv);
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('tv', tv);
      document.documentElement.classList.toggle('tv-host', tv);
    }
  }

  private detect(): boolean {
    if (typeof window === 'undefined') return false;

    // 1. UA marker injected by MainActivity when UiModeManager reports television
    if (typeof navigator !== 'undefined' && /AndroidTV\/\d/.test(navigator.userAgent)) return true;

    // 2. No-pointer media query (TVs report `pointer: none` since the only input is the D-pad)
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: none)').matches) {
      return true;
    }

    // 3. UA sniff (best effort) — only when running natively on Android
    if (Capacitor.getPlatform() === 'android') {
      const ua = navigator.userAgent;
      if (/Android.*TV|BRAVIA|SHIELD|AFT[A-Z0-9]+/i.test(ua)) return true;
    }

    return false;
  }
}
