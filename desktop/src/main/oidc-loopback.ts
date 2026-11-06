import http from 'node:http';

/** Localized strings of the page the browser lands on, supplied by the renderer. */
export interface OidcPage {
  title: string;
  message: string;
}

// The server keeps a sign-in attempt for 10 minutes: the listener lives as long.
const TIMEOUT_MS = 10 * 60_000;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function pageHtml({ title, message }: OidcPage): string {
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:sans-serif;text-align:center;margin-top:20vh"><h1>${esc(title)}</h1><p>${esc(message)}</p>`;
}

/** The tab after a callback with a code (the outcome is only known once the app exchanged it) and after one with an error. */
export interface OidcPages {
  done: OidcPage;
  failed: OidcPage;
}

interface Listener {
  id: number;
  /** The `state` of the sign-in in flight: any other request is refused and does not end the wait. */
  expected: string | null;
  close(): void;
  done: Promise<string | null>;
}

let active: Listener | null = null;
let nextId = 0;

/** Listens on 127.0.0.1 for one `/oidc` redirect; a later call cancels this one. */
export async function oidcListen(pages: OidcPages, timeoutMs = TIMEOUT_MS): Promise<{ id: number; port: number }> {
  active?.close();
  let settle!: (r: string | null) => void;
  const done = new Promise<string | null>((r) => (settle = r));
  let port = 0;
  const listener: Listener = { id: ++nextId, expected: null, close: () => close(null), done };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const state = url.searchParams.get('state');
    const hasResult = url.searchParams.has('code') || url.searchParams.has('error');
    const status =
      url.pathname !== '/oidc' || req.method !== 'GET'
        ? 404
        : req.headers.host !== `127.0.0.1:${port}` || !hasResult || !state || state !== listener.expected
          ? 400
          : 200;
    if (status !== 200) {
      res.writeHead(status, { Connection: 'close' }).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
    res.end(pageHtml(url.searchParams.has('error') ? pages.failed : pages.done), () => close(url.search.slice(1)));
  });
  const timer = setTimeout(() => close(null), timeoutMs);
  let closed = false;
  function close(result: string | null): void {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (active === listener) active = null;
    server.close();
    server.closeAllConnections();
    settle(result);
  }
  active = listener;
  try {
    await new Promise<void>((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  } catch (err) {
    close(null);
    throw err;
  }
  port = (server.address() as { port: number }).port;
  return { id: listener.id, port };
}

/** The callback query string of listener `id` once it carries `state`; null on timeout or when the
 *  listener was cancelled or replaced. */
export function oidcWait(id: number, state: string): Promise<string | null> {
  if (active?.id !== id) return Promise.resolve(null);
  active.expected = state;
  return active.done;
}

export function oidcCancel(id: number): void {
  if (active?.id === id) active.close();
}
