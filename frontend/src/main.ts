import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Android TV detection must run BEFORE Angular bootstraps so the `tv` body
// class is in place when component templates are first instantiated. The class
// drives the 10-foot UX overrides (focus rings, larger fonts, no touch
// gestures); we keep the mobile layout otherwise — desktop's pinned sidebar
// turned out to be less practical with a remote on this codebase.
(function applyTvBootstrapTweaks() {
  const ua = navigator.userAgent;
  const matchMedia = typeof window.matchMedia === 'function' ? window.matchMedia : null;
  const isAndroid = /Android/.test(ua);
  const noFinePointer = !!matchMedia && matchMedia('(any-pointer: fine)').matches === false;
  const wideLandscape = window.screen.width >= 1280 && window.screen.width >= window.screen.height;
  const isTv =
    /AndroidTV\/\d/.test(ua) ||
    (matchMedia && matchMedia('(pointer: none)').matches) ||
    /Android.*TV|BRAVIA|SHIELD|AFT[A-Z0-9]+|GoogleTV/i.test(ua) ||
    (isAndroid && wideLandscape && noFinePointer);
  if (!isTv) return;
  document.documentElement.classList.add('tv-host');
  document.body.classList.add('tv');
})();

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
