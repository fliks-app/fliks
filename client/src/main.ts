import './polyfills';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { applyDeviceOverrideFromUrl, detectDevice } from './app/core/services/device.service';

// Pre-bootstrap TV detection poses `body.tv` before Angular renders to avoid flashing the mobile/desktop layout.
(function applyTvBootstrapTweaks() {
  applyDeviceOverrideFromUrl();
  const { formFactor, tvPlatform } = detectDevice();
  if (formFactor !== 'tv') return;
  document.documentElement.classList.add('tv-host');
  document.body.classList.add('tv');
  if (tvPlatform) document.body.classList.add(`tv-${tvPlatform}`);

  // The 10-foot UI is authored for 1280; the Android TV WebView lays out at
  // device-width, which falls below Tailwind's `lg` breakpoint.
  if (tvPlatform === 'androidtv') {
    document
      .querySelector('meta[name="viewport"]')
      ?.setAttribute('content', 'width=1280, viewport-fit=cover');
  }
})();

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
