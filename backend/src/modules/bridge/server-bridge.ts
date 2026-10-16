import type { Dispatcher } from 'undici';

/** Nest to fliks-server calls (server/docs/bridge.md): base URL and bearer token come from the env fliks-server sets at spawn. */
export function bridgeConfigured(): boolean {
  return !!process.env.FLIKS_SERVER_URL && !!process.env.FLIKS_BRIDGE_TOKEN;
}

interface BridgeInit {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  dispatcher?: Dispatcher;
  /** Keep the connection open and hand back the response (the SSE stream). */
  raw?: boolean;
}

/** Throws on a non-2xx (the error carries `status`). Returns the parsed JSON, `undefined` on 204, or the response when `raw`. */
export async function bridgeFetch(
  path: string,
  init: BridgeInit & { raw: true },
): Promise<Response>;
export async function bridgeFetch(
  path: string,
  init?: BridgeInit,
): Promise<unknown>;
export async function bridgeFetch(
  path: string,
  init: BridgeInit = {},
): Promise<unknown> {
  if (!bridgeConfigured()) throw new Error('bridge not configured');
  const res = await fetch(`${process.env.FLIKS_SERVER_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${process.env.FLIKS_BRIDGE_TOKEN}`,
      ...(init.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal ?? AbortSignal.timeout(5_000),
    // undici's own fetch options; the DOM RequestInit typing lacks them.
    dispatcher: init.dispatcher,
  } as RequestInit);
  if (!res.ok) {
    throw Object.assign(new Error(`${path} answered ${res.status}`), {
      status: res.status,
    });
  }
  if (init.raw) return res;
  return res.status === 204 ? undefined : res.json();
}
