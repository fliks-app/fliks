import { session } from 'electron';
import { APP_SCHEME } from './protocol';

const APP_ORIGIN = `${APP_SCHEME}://app`;

/**
 * The Angular client runs at origin `fliks://app` and calls the user's Fliks
 * server cross-origin. Servers only allowlist the known web/mobile origins, so
 * their responses lack `Access-Control-Allow-Origin: fliks://app` and the
 * browser blocks them. A trusted desktop client is the same situation as the
 * mobile apps, which bypass CORS via Capacitor's native HTTP layer — here we
 * reflect the app origin onto every response so credentialed API calls pass.
 * No backend change required.
 */
export function installCorsBypass(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    // Drop any existing (case-variant) CORS headers before setting ours.
    for (const key of Object.keys(headers)) {
      const k = key.toLowerCase();
      if (k === 'access-control-allow-origin' || k === 'access-control-allow-credentials') {
        delete headers[key];
      }
    }
    headers['Access-Control-Allow-Origin'] = [APP_ORIGIN];
    headers['Access-Control-Allow-Credentials'] = ['true'];
    callback({ responseHeaders: headers });
  });
}
