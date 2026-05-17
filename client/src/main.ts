import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Pre-bootstrap TV detection: posing `body.tv` before Angular renders avoids a
// flash of mobile/desktop layout on Android TV. We keep the rule **strict** —
// only true TVs should match. DeviceService re-runs the same checks plus the
// touch-device split (phone/tablet) once the app is up.
//
// History: a previous heuristic added `(android && wideLandscape && noFinePointer)`
// here, which mis-detected Android tablets in landscape as TVs and broke their
// touch UX. Removed.
(function applyTvBootstrapTweaks() {
  const ua = navigator.userAgent;
  const matchMedia = typeof window.matchMedia === 'function' ? window.matchMedia : null;
  let override: string | null = null;
  try {
    override = window.localStorage.getItem('fliks.deviceOverride');
  } catch {
    /* ignore */
  }
  const params = new URLSearchParams(window.location.search);
  const queryOverride = (['tv', 'tablet', 'phone', 'desktop'] as const).find((k) => params.has(k));
  const effectiveOverride = queryOverride ?? override;
  if (effectiveOverride && effectiveOverride !== 'tv') return;
  const isTv =
    effectiveOverride === 'tv' ||
    /AndroidTV\/\d/.test(ua) ||
    /Tizen |Web0S|webOS|SMART-TV/i.test(ua) ||
    (matchMedia && matchMedia('(pointer: none)').matches) ||
    /Android.*TV|BRAVIA|SHIELD|AFT[A-Z0-9]+|GoogleTV/i.test(ua);
  if (!isTv) return;
  document.documentElement.classList.add('tv-host');
  document.body.classList.add('tv');
})();

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
