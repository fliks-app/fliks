import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Pre-bootstrap TV detection: pose `body.tv` (and `body.tv-{platform}`)
// before Angular renders so the 10-foot CSS variants take effect without
// flashing the mobile/desktop layout. Kept strict — only true TVs match.
// DeviceService re-runs the same checks (plus the touch-device split for
// phone/tablet) once the app is up.
(function applyTvBootstrapTweaks() {
  const ua = navigator.userAgent;
  const matchMedia = typeof window.matchMedia === 'function' ? window.matchMedia : null;
  let override: string | null = null;
  let tvPlatformOverride: string | null = null;
  try {
    override = window.localStorage.getItem('fliks.deviceOverride');
    tvPlatformOverride = window.localStorage.getItem('fliks.tvPlatformOverride');
  } catch {
    /* ignore */
  }
  const params = new URLSearchParams(window.location.search);
  const queryOverride = (['tv', 'tablet', 'phone', 'desktop'] as const).find((k) => params.has(k));
  const effectiveOverride = queryOverride ?? override;
  if (effectiveOverride && effectiveOverride !== 'tv') return;

  let platform: 'androidtv' | 'tizen' | 'webos' | null = null;
  if (/AndroidTV\/\d/.test(ua)) platform = 'androidtv';
  else if (/\bTizen\b|SMART-TV/i.test(ua)) platform = 'tizen';
  else if (/Web0S|webOS/.test(ua)) platform = 'webos';
  else if (/Android.*TV|BRAVIA|SHIELD|AFT[A-Z0-9]+|GoogleTV/i.test(ua)) platform = 'androidtv';

  const queryTvPlatform = params.get('tvplatform');
  if (
    queryTvPlatform === 'androidtv' ||
    queryTvPlatform === 'tizen' ||
    queryTvPlatform === 'webos'
  ) {
    platform = queryTvPlatform;
  } else if (
    !platform &&
    (tvPlatformOverride === 'androidtv' ||
      tvPlatformOverride === 'tizen' ||
      tvPlatformOverride === 'webos')
  ) {
    platform = tvPlatformOverride;
  }

  const isTv =
    effectiveOverride === 'tv' ||
    platform !== null ||
    (matchMedia && matchMedia('(pointer: none)').matches);
  if (!isTv) return;
  document.documentElement.classList.add('tv-host');
  document.body.classList.add('tv');
  if (platform) document.body.classList.add(`tv-${platform}`);
})();

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
