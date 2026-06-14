import { protocol, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// Serves the built Angular client over a custom scheme so client-side routing
// and absolute asset paths work (file:// breaks both). Deep links with no file
// extension fall back to index.html, letting the Angular router take over.
export const APP_SCHEME = 'fliks';
export const APP_URL = `${APP_SCHEME}://app/`;

/** Must run before app `ready`. */
export function registerAppSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

export function registerAppProtocol(webDir: string): void {
  const root = path.resolve(webDir);
  protocol.handle(APP_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
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
    return net.fetch(pathToFileURL(filePath).toString());
  });
}
