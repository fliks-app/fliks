import { Injectable, computed, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

export type InputMode = 'mouse' | 'touch' | 'dpad';
export type FormFactor = 'desktop' | 'phone' | 'tablet' | 'tv';
/** OS under a `formFactor=tv`: drives platform glue (remote keys, exit, packaging); UI gates should read `formFactor` instead. */
export type TvPlatform = 'androidtv' | 'tizen' | 'webos' | null;
/** Desktop shell under a `formFactor=desktop`; drives native-player engine selection, the counterpart of TvPlatform. */
export type DesktopPlatform = 'electron' | null;

/** Android's sw600dp tablet cut, on the shorter side so the launch orientation doesn't matter. */
const TABLET_MIN_SHORT_SIDE = 600;
const OVERRIDE_KEY = 'fliks.deviceOverride';
const TV_PLATFORM_OVERRIDE_KEY = 'fliks.tvPlatformOverride';

function readOverride(): DetectResult | null {
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

/** Form factor, input modality and TV OS; module-scope so bootstrap-time providers can branch before the injector exists. */
export function detectDevice(): DetectResult {
  if (typeof window === 'undefined') {
    return { input: 'mouse', formFactor: 'desktop', tvPlatform: null };
  }

  const override = readOverride();
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
    const side = Math.min(window.innerWidth, window.innerHeight);
    return {
      input: 'touch',
      formFactor: side < TABLET_MIN_SHORT_SIDE ? 'phone' : 'tablet',
      tvPlatform: null,
    };
  }

  // 8. Default
  return { input: 'mouse', formFactor: 'desktop', tvPlatform: null };
  }

/** Whether router view transitions are registered, i.e. whether the player's closing animation is theirs to run. */
export function viewTransitionsEnabled(): boolean {
  return typeof document !== 'undefined' && !!document.startViewTransition;
}

interface DetectResult {
  input: InputMode;
  formFactor: FormFactor;
  tvPlatform: TvPlatform;
}

/** Single source of truth for input modality and form factor (two orthogonal axes), detected in decreasing confidence order;
 *  `?tv=1`/`?tablet=1`/`?phone=1` force one for QA. Keeps `body.{tv,tablet,phone}` and `body.tv-{platform}` classes in sync. */
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

  /** Downloads work only in a browser or Electron: Capacitor WebViews have no download handler and a TV has nowhere to save. */
  readonly canSaveFiles = computed(
    () => !this.isTv() && (this.isDesktopNative() || !Capacitor.isNativePlatform()),
  );

  /** A file picker works everywhere but TV (no local storage); both Capacitor WebViews handle <input type=file>. */
  readonly canPickFiles = computed(() => !this.isTv());

  /** Android's picker filters by MIME and its table maps none of the sidecar
   *  extensions, so anything narrower than a wildcard greys out every file. */
  filePickerAccept(accept: string): string {
    return this.isAndroidNative() ? '*/*' : accept;
  }

  /** Running inside the Capacitor Android WebView. */
  readonly isAndroidNative = computed(
    () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android',
  );

  /** Running inside the Capacitor iOS WebView. */
  readonly isIosNative = computed(
    () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios',
  );

  constructor() {
    this.applyOverrideFromUrl();
    const detected = detectDevice();
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
      const next = detectDevice();
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

    // Per-OS hook for CSS, mirrored on <html> because overlays are reparented out of <body>.
    const platforms: TvPlatform[] = ['androidtv', 'tizen', 'webos'];
    for (const p of platforms) {
      const on = this.tvPlatform() === p;
      body.classList.toggle(`tv-${p}`, on);
      html.classList.toggle(`tv-${p}`, on);
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


}
