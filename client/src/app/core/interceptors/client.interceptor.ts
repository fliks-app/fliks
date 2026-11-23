import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { environment } from '../../../environments/environment';
import { detectDevice } from '../services/device.service';
import { ServerConfigService } from '../services/server-config.service';
import { targetsActiveServer } from './credentials.interceptor';

// Raw platform facts, never the QA override.
function platform(): string {
  if (Capacitor.isNativePlatform()) return Capacitor.getPlatform();
  if (detectDevice().desktopPlatform) return 'desktop';
  const ua = navigator.userAgent;
  return /\bTizen\b|SMART-TV/.test(ua) ? 'tizen' : /Web0S|webOS/.test(ua) ? 'webos' : 'web';
}

let client: string | undefined;

/** Names this build to the server (`<platform>/<version>`) for its compatibility accounting. */
export const clientInterceptor: HttpInterceptorFn = (req, next) => {
  const base = inject(ServerConfigService).serverUrl();
  if (!targetsActiveServer(req.url, base)) return next(req);
  client ??= `${platform()}/${environment.version}`;
  return next(req.clone({ setHeaders: { 'X-Fliks-Client': client } }));
};
