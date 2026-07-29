import { Injectable, computed, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

export type InputMode = 'mouse' | 'touch' | 'dpad';
export type FormFactor = 'desktop' | 'phone' | 'tablet' | 'tv';
/**
 * OS underneath a `formFactor=tv`. Drives platform-specific glue (remote
 * key registration, exit handling, store packaging) without leaking into
 * UI gates — those should read `formFactor === 'tv'` for visual rules
 * and the platform enum only for OS-bound capabilities.
 */
export type TvPlatform = 'androidtv' | 'tizen' | 'webos' | null;
/**
 * Desktop shell underneath a `formFactor=desktop`. Drives the native-player
 * engine selection and packaging glue, the desktop counterpart of TvPlatform.
 */
export type DesktopPlatform = 'electron' | null;

const TABLET_MIN_WIDTH = 768;
const OVERRIDE_KEY = 'fliks.deviceOverride';
const TV_PLATFORM_OVERRIDE_KEY = 'fliks.tvPlatformOverride';

interface DetectResult {
  input: InputMode;
  formFactor: FormFactor;
  tvPlatform: TvPlatform;
}

/**
 * Single source of truth for input modality and form-factor. Two orthogonal axes
 * because they don't always correlate (e.g. tablet + Bluetooth keyboard, TV + mouse).
 *
 * Detection order, highest confidence first:
 *  1. UA marker `AndroidTV/\d` injected by MainActivity in `UI_MODE_TYPE_TELEVISION`.
 *  2. Tizen UA (`Tizen` or `SMART-TV`) → Samsung Smart TV.
 *  3. webOS UA (`Web0S`/`webOS`) → LG Smart TV.
 *  4. `(pointer: none)` media query — only D-pads, no pointer at all.
 *  5. TV-only UA sniff (BRAVIA / SHIELD / Fire TV / GoogleTV) on native Android.
 *  6. URL `?tv=1` / `?tablet=1` / `?phone=1` (persisted in localStorage) for QA.
 *     `?tvplatform=tizen|webos|androidtv` pins the platform when forcing TV.
 *  7. `(pointer: coarse)` → phone if vw < 768, tablet otherwise.
 *  8. Default → desktop + mouse.
 *
 * `body.{tv,tablet,phone}` classes are kept in sync so global Tailwind/CSS variants
 * can drive 10-foot UI overrides without each component branching on the signal.
 * `body.tv-{platform}` lets per-OS CSS hooks attach to the same source of truth.
 */
@Injectable({ providedIn: 'root' })
export class DeviceService {
  readonly input = signal<InputMode>('mouse');
  readonly formFactor = signal<FormFactor>('desktop');
  readonly tvPlatform = signal<TvPlatform>(null);
  readonly desktopPlatform = signal<DesktopPlatform>(null);

  /** Running inside the native desktop shell (Electron + embedded mpv). */
  readonly isDesktopNative = computed(() => this.desktopPlatform() !== null);
  readonly isTv = computed(() => this.formFactor() === 'tv');
  readonly isTablet = computed(() => this.formFactor() === 'tablet');
  readonly isPhone = computed(() => this.formFactor() === 'phone');
  readonly isDesktop = computed(() => this.formFactor() === 'desktop');
  readonly isTouch = computed(() => this.input() === 'touch');
  readonly isDpad = computed(() => this.input() === 'dpad');

  /** A download link reaches a real file only in a browser or the Electron
   *  shell. The Capacitor WebViews have no download handler (Android needs
   *  `setDownloadListener`, iOS a `WKDownloadDelegate`) and a TV has nowhere to
   *  put one, so the link would silently do nothing there. */
  readonly canSaveFiles = computed(
    () => !this.isTv() && (this.isDesktopNative() || !Capacitor.isNativePlatform()),
  );

  /** Running inside the Capacitor Android WebView. */
  readonly isAndroidNative = computed(
    () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android',
  );

  constructor() {
    this.applyOverrideFromUrl();
    const detected = this.detect();
    this.input.set(detected.input);
    this.formFactor.set(detected.formFactor);
    this.tvPlatform.set(detected.tvPlatform);
    this.desktopPlatform.set(this.detectDesktopPlatform());
    this.syncBodyClasses();
    this.bindResize();
    // Visible in remote debug (chrome://inspect) — invisible in normal use.
    // eslint-disable-next-line no-console
    console.info(
      '[device]',
      this.formFactor(),
      this.input(),
      this.tvPlatform() ?? 'no-tv-platform',
      navigator.userAgent,
    );
  }

  private detect(): DetectResult {
    if (typeof window === 'undefined') {
      return { input: 'mouse', formFactor: 'desktop', tvPlatform: null };
    }

    const override = this.readOverride();
    if (override) return override;

    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const mm = typeof window.matchMedia === 'function' ? window.matchMedia : null;

    // 1. AndroidTV marker (Capacitor MainActivity injects it)
    if (/AndroidTV\/\d/.test(ua)) {
      return { input: 'dpad', formFactor: 'tv', tvPlatform: 'androidtv' };
    }

    // 2. Samsung Tizen
    if (/\bTizen\b|SMART-TV/i.test(ua)) {
      return { input: 'dpad', formFactor: 'tv', tvPlatform: 'tizen' };
    }

    // 3. LG webOS (UA writes either `Web0S` with a zero or `webOS`)
    if (/Web0S|webOS/.test(ua)) {
      return { input: 'dpad', formFactor: 'tv', tvPlatform: 'webos' };
    }

    // 4. No pointer at all → TV with no detectable OS
    if (mm && mm('(pointer: none)').matches) {
      return { input: 'dpad', formFactor: 'tv', tvPlatform: null };
    }

    // 5. TV-only UA sniff (best effort, only on native Android)
    if (
      Capacitor.getPlatform() === 'android' &&
      /Android.*TV|BRAVIA|SHIELD|AFT[A-Z0-9]+|GoogleTV/i.test(ua)
    ) {
      return { input: 'dpad', formFactor: 'tv', tvPlatform: 'androidtv' };
    }

    // 7. Coarse pointer → touch device, split by viewport
    const coarse = mm && mm('(pointer: coarse)').matches;
    if (coarse) {
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      return {
        input: 'touch',
        formFactor: vw < TABLET_MIN_WIDTH ? 'phone' : 'tablet',
        tvPlatform: null,
      };
    }

    // 8. Default
    return { input: 'mouse', formFactor: 'desktop', tvPlatform: null };
  }

  /** Electron desktop shell: the preload bridge is authoritative; the UA tag
   *  is a fallback for the brief window before it attaches. */
  private detectDesktopPlatform(): DesktopPlatform {
    if (typeof window === 'undefined') return null;
    if (window.fliksDesktop) return 'electron';
    if (typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent)) {
      return 'electron';
    }
    return null;
  }

  /** Re-detect on resize (covers tablet rotation crossing the 768 px breakpoint). */
  private bindResize() {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      // Only the form-factor side changes with viewport — input mode + tv platform stay put.
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

    // Per-platform hook so CSS can target a specific TV OS without
    // duplicating the formFactor check in every selector.
    const platforms: TvPlatform[] = ['androidtv', 'tizen', 'webos'];
    for (const p of platforms) {
      body.classList.toggle(`tv-${p}`, this.tvPlatform() === p);
    }
  }

  private applyOverrideFromUrl() {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const force = (['tv', 'tablet', 'phone', 'desktop'] as const).find(
      (k) => params.has(k) && params.get(k) !== '0',
    );
    if (force) {
      try {
        window.localStorage.setItem(OVERRIDE_KEY, force);
      } catch {
        /* localStorage may be unavailable (private mode) */
      }
    } else if (params.has('reset-device')) {
      try {
        window.localStorage.removeItem(OVERRIDE_KEY);
        window.localStorage.removeItem(TV_PLATFORM_OVERRIDE_KEY);
      } catch {
        /* ignore */
      }
    }
    const tvPlatformParam = params.get('tvplatform');
    if (
      tvPlatformParam === 'androidtv' ||
      tvPlatformParam === 'tizen' ||
      tvPlatformParam === 'webos' ||
      tvPlatformParam === 'none'
    ) {
      try {
        if (tvPlatformParam === 'none') {
          window.localStorage.removeItem(TV_PLATFORM_OVERRIDE_KEY);
        } else {
          window.localStorage.setItem(TV_PLATFORM_OVERRIDE_KEY, tvPlatformParam);
        }
      } catch {
        /* ignore */
      }
    }
  }

  private readOverride(): DetectResult | null {
    if (typeof window === 'undefined') return null;
    let value: string | null = null;
    let tvPlatformOverride: TvPlatform = null;
    try {
      value = window.localStorage.getItem(OVERRIDE_KEY);
      const tvp = window.localStorage.getItem(TV_PLATFORM_OVERRIDE_KEY);
      if (tvp === 'androidtv' || tvp === 'tizen' || tvp === 'webos') {
        tvPlatformOverride = tvp;
      }
    } catch {
      return null;
    }
    switch (value) {
      case 'tv':
        return { input: 'dpad', formFactor: 'tv', tvPlatform: tvPlatformOverride };
      case 'tablet':
        return { input: 'touch', formFactor: 'tablet', tvPlatform: null };
      case 'phone':
        return { input: 'touch', formFactor: 'phone', tvPlatform: null };
      case 'desktop':
        return { input: 'mouse', formFactor: 'desktop', tvPlatform: null };
      default:
        return null;
    }
  }
}
