import { session } from 'electron';
import { APP_SCHEME } from './protocol';
import { appendLog, redactQuery } from './log-file';
import { isReportedServer, noteValidChain } from './trusted-servers';

const APP_ORIGIN = `${APP_SCHEME}://app`;

const METHODS = 'GET, HEAD, PUT, PATCH, POST, DELETE';

/**
 * The Angular client runs at origin `fliks://app` and calls the user's Fliks server cross-origin, and
 * servers only allowlist the known web/mobile origins. Responses of the servers the page reported
 * (and only those) are rewritten to allow `fliks://app`, preflights included.
 */
export function corsResponseHeaders(
  headers: Record<string, string[]>,
  preflightRequestHeaders: string | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key.toLowerCase().startsWith('access-control-')) out[key] = value;
  }
  out['Access-Control-Allow-Origin'] = [APP_ORIGIN];
  out['Access-Control-Allow-Credentials'] = ['true'];
  // The page reads Content-Range, Content-Disposition and the like: expose what the response carries.
  out['Access-Control-Expose-Headers'] = [Object.keys(out).join(', ')];
  if (preflightRequestHeaders !== undefined) {
    out['Access-Control-Allow-Methods'] = [METHODS];
    out['Access-Control-Allow-Headers'] = [preflightRequestHeaders];
  }
  return out;
}

/** Notifications, fullscreen, and the microphone (the voice chat; never video capture). */
export function permissionAllowed(permission: string, mediaTypes?: readonly string[]): boolean {
  if (permission === 'media') return (mediaTypes ?? []).every((t) => t === 'audio');
  return permission === 'notifications' || permission === 'fullscreen' || permission === 'clipboard-sanitized-write';
}

export function installCorsBypass(): void {
  const { webRequest } = session.defaultSession;
  const preflightHeaders = new Map<number, string>();
  webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.method === 'OPTIONS') {
      const asked = Object.entries(details.requestHeaders).find(([k]) => k.toLowerCase() === 'access-control-request-headers');
      if (asked) preflightHeaders.set(details.id, asked[1]);
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  webRequest.onHeadersReceived((details, callback) => {
    const asked = preflightHeaders.get(details.id);
    preflightHeaders.delete(details.id);
    if (!isReportedServer(details.url)) return callback({});
    const preflight = details.method === 'OPTIONS' ? (asked ?? '') : undefined;
    callback({
      responseHeaders: corsResponseHeaders(details.responseHeaders ?? {}, preflight),
      ...(preflight === undefined ? {} : { statusLine: 'HTTP/1.1 204 No Content' }),
    });
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(permissionAllowed(permission, (details as { mediaTypes?: string[] }).mediaTypes)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    const type = (details as { mediaType?: string }).mediaType;
    return permissionAllowed(permission, type ? [type] : undefined);
  });

  // A renderer network failure only ever surfaces as a bare `status 0` — this
  // is the one place the underlying ERR_* (reset / TLS / network-changed) is
  // available at all.
  webRequest.onErrorOccurred((details) => {
    appendLog(`[net] ${details.method} ${redactQuery(details.url)} ${details.error}`);
  });

  // Ranks the CORS-preflight hypothesis for a failed /api/ call: an OPTIONS
  // that never resolves, or resolves without the right headers, precedes it.
  webRequest.onCompleted((details) => {
    if (!details.fromCache) noteValidChain(details.url);
    if (details.method === 'OPTIONS' && details.url.includes('/api/')) {
      appendLog(`[net] OPTIONS ${redactQuery(details.url)} -> ${details.statusCode}`);
    }
  });
}
