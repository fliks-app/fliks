import { protocol, net, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// Serves the built Angular client over a custom scheme so client-side routing
// and absolute asset paths work (file:// breaks both). Deep links with no file
// extension fall back to index.html, letting the Angular router take over.
export const APP_SCHEME = 'fliks';
export const APP_URL = `${APP_SCHEME}://app/`;
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'";

/** Must run before app `ready`. */
export function registerAppSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

const LOCAL_PREFIX = '_local/';

/** Where the page loads a downloaded sidecar or book file from: a file:// URL is refused to a page that is not file://. */
export const localFileUrl = (name: string) => `${APP_URL}${LOCAL_PREFIX}${encodeURIComponent(name)}`;

/** Whether an IPC call comes from the app page's top frame, not a frame it embeds. */
export function fromAppPage(e: IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  return !!frame && frame === e.sender.mainFrame && frame.url.startsWith(APP_URL);
}

/** `resolveLocal` maps a downloaded file's name to its path, or null. */
export function registerAppProtocol(webDir: string, resolveLocal: (name: string) => string | null): void {
  const root = path.resolve(webDir);
  protocol.handle(APP_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(`/${LOCAL_PREFIX}`)) {
      const file = resolveLocal(decodeURIComponent(pathname.slice(LOCAL_PREFIX.length + 1)));
      if (!file) return new Response('not found', { status: 404 });
      // The headers carry the Range of a seek.
      return net.fetch(pathToFileURL(file).toString(), { headers: request.headers });
    }
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    let filePath = path.join(root, rel);

    // SPA fallback: a route (no file extension) → index.html.
    if (!path.extname(rel)) {
      filePath = path.join(root, 'index.html');
    }

    // Block path traversal outside the web root.
    if (!filePath.startsWith(root)) {
      return new Response('forbidden', { status: 403 });
    }
    if (!fs.existsSync(filePath)) {
      return new Response('not found', { status: 404 });
    }
    const res = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  });
}
