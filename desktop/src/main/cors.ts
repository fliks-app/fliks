import { session } from 'electron';
import { APP_SCHEME } from './protocol';
import { appendLog, redactQuery } from './log-file';

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
  const { webRequest } = session.defaultSession;
  webRequest.onHeadersReceived((details, callback) => {
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

  // Everything stays allowed as before except video capture: only the voice-chat microphone is granted.
  const allowed = (permission: string, mediaTypes?: readonly string[]) =>
    permission !== 'media' || (mediaTypes ?? []).every((t) => t === 'audio');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(allowed(permission, (details as { mediaTypes?: string[] }).mediaTypes)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) =>
    allowed(permission, (details as { mediaType?: string }).mediaType ? [(details as { mediaType: string }).mediaType] : undefined),
  );

  // A renderer network failure only ever surfaces as a bare `status 0` — this
  // is the one place the underlying ERR_* (reset / TLS / network-changed) is
  // available at all.
  webRequest.onErrorOccurred((details) => {
    appendLog(`[net] ${details.method} ${redactQuery(details.url)} ${details.error}`);
  });

  // Ranks the CORS-preflight hypothesis for a failed /api/ call: an OPTIONS
  // that never resolves, or resolves without the right headers, precedes it.
  webRequest.onCompleted((details) => {
    if (details.method === 'OPTIONS' && details.url.includes('/api/')) {
      appendLog(`[net] OPTIONS ${redactQuery(details.url)} -> ${details.statusCode}`);
    }
  });
}
