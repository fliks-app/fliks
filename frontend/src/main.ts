import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Android TV detection must run BEFORE Angular bootstraps so the initial layout
// pass uses the desktop viewport (`width=1280`) and the `tv` body class is in
// place when component templates are first instantiated. Otherwise the first
// render is in mobile mode and we can only "upgrade" to desktop after the fact.
(function applyTvBootstrapTweaks() {
  const ua = navigator.userAgent;
  const matchMedia = typeof window.matchMedia === 'function' ? window.matchMedia : null;
  const isAndroid = /Android/.test(ua);
  // A landscape Android device with a wide screen and either no pointer or a
  // coarse-only pointer is almost certainly a TV/leanback box (phones default
  // to portrait; the rare Android tablet hits the same fallback but that's an
  // acceptable false positive — it'll just get a desktop layout).
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
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) meta.content = 'width=1280, initial-scale=1, viewport-fit=cover';
})();

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
