import { Injectable, computed, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

export type InputMode = 'mouse' | 'touch' | 'dpad';
export type FormFactor = 'desktop' | 'phone' | 'tablet' | 'tv';

const TABLET_MIN_WIDTH = 768;
const OVERRIDE_KEY = 'fliks.deviceOverride';

/**
 * Single source of truth for input modality and form-factor. Two orthogonal axes
 * because they don't always correlate (e.g. tablet + Bluetooth keyboard, TV + mouse).
 *
 * Detection order, highest confidence first:
 *  1. UA marker `AndroidTV/\d` injected by MainActivity in `UI_MODE_TYPE_TELEVISION`.
 *  2. `(pointer: none)` media query — only D-pads, no pointer at all.
 *  3. TV-only UA sniff (BRAVIA / SHIELD / Fire TV / GoogleTV) on native Android.
 *  4. URL `?tv=1` / `?tablet=1` / `?phone=1` (persisted in localStorage) for QA.
 *  5. `(pointer: coarse)` → phone if vw < 768, tablet otherwise.
 *  6. Default → desktop + mouse.
 *
 * `body.{tv,tablet,phone}` classes are kept in sync so global Tailwind/CSS variants
 * can drive 10-foot UI overrides without each component branching on the signal.
 */
@Injectable({ providedIn: 'root' })
export class DeviceService {
  readonly input = signal<InputMode>('mouse');
  readonly formFactor = signal<FormFactor>('desktop');

  readonly isTv = computed(() => this.formFactor() === 'tv');
  readonly isTablet = computed(() => this.formFactor() === 'tablet');
  readonly isPhone = computed(() => this.formFactor() === 'phone');
  readonly isDesktop = computed(() => this.formFactor() === 'desktop');
  readonly isTouch = computed(() => this.input() === 'touch');
  readonly isDpad = computed(() => this.input() === 'dpad');

  constructor() {
    this.applyOverrideFromUrl();
    const detected = this.detect();
    this.input.set(detected.input);
    this.formFactor.set(detected.formFactor);
    this.syncBodyClasses();
    this.bindResize();
    // Visible in remote debug (chrome://inspect) — invisible in normal use.
    // eslint-disable-next-line no-console
    console.info('[device]', this.formFactor(), this.input(), navigator.userAgent);
  }

  private detect(): { input: InputMode; formFactor: FormFactor } {
    if (typeof window === 'undefined') return { input: 'mouse', formFactor: 'desktop' };

    const override = this.readOverride();
    if (override) return override;

    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const mm = typeof window.matchMedia === 'function' ? window.matchMedia : null;

    // 1. UA marker
    if (/AndroidTV\/\d/.test(ua)) return { input: 'dpad', formFactor: 'tv' };

    // 2. No pointer at all
    if (mm && mm('(pointer: none)').matches) return { input: 'dpad', formFactor: 'tv' };

    // 3. TV-only UA sniff (best effort, only on native Android)
    if (Capacitor.getPlatform() === 'android' && /Android.*TV|BRAVIA|SHIELD|AFT[A-Z0-9]+|GoogleTV/i.test(ua)) {
      return { input: 'dpad', formFactor: 'tv' };
    }

    // 5. Coarse pointer → touch device, split by viewport
    const coarse = mm && mm('(pointer: coarse)').matches;
    if (coarse) {
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      return { input: 'touch', formFactor: vw < TABLET_MIN_WIDTH ? 'phone' : 'tablet' };
    }

    // 6. Default
    return { input: 'mouse', formFactor: 'desktop' };
  }

  /** Re-detect on resize (covers tablet rotation crossing the 768 px breakpoint). */
  private bindResize() {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      // Only the form-factor side changes with viewport — input mode stays put.
      const next = this.detect();
      if (next.formFactor !== this.formFactor()) {
        this.formFactor.set(next.formFactor);
        this.syncBodyClasses();
      }
    };
    window.addEventListener('resize', onResize, { passive: true });
  }

  private syncBodyClasses() {
    if (typeof document === 'undefined') return;
    const body = document.body;
    const html = document.documentElement;
    body.classList.toggle('tv', this.formFactor() === 'tv');
    body.classList.toggle('tablet', this.formFactor() === 'tablet');
    body.classList.toggle('phone', this.formFactor() === 'phone');
    html.classList.toggle('tv-host', this.formFactor() === 'tv');
  }

  private applyOverrideFromUrl() {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const force = (['tv', 'tablet', 'phone', 'desktop'] as const).find((k) => params.has(k) && params.get(k) !== '0');
    if (force) {
      try {
        window.localStorage.setItem(OVERRIDE_KEY, force);
      } catch {
        /* localStorage may be unavailable (private mode) */
      }
    } else if (params.has('reset-device')) {
      try {
        window.localStorage.removeItem(OVERRIDE_KEY);
      } catch {
        /* ignore */
      }
    }
  }

  private readOverride(): { input: InputMode; formFactor: FormFactor } | null {
    if (typeof window === 'undefined') return null;
    let value: string | null = null;
    try {
      value = window.localStorage.getItem(OVERRIDE_KEY);
    } catch {
      return null;
    }
    switch (value) {
      case 'tv':      return { input: 'dpad',  formFactor: 'tv' };
      case 'tablet':  return { input: 'touch', formFactor: 'tablet' };
      case 'phone':   return { input: 'touch', formFactor: 'phone' };
      case 'desktop': return { input: 'mouse', formFactor: 'desktop' };
      default:        return null;
    }
  }
}
