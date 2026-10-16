import type { SpriteMeta } from '../engine/engine.service';

/** Nest to fliks-server calls (server/docs/bridge.md): base URL and bearer token come from the env fliks-server sets at spawn. */
export function bridgeConfigured(): boolean {
  return !!process.env.FLIKS_SERVER_URL && !!process.env.FLIKS_BRIDGE_TOKEN;
}

interface BridgeInit {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
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
  });
  if (!res.ok) {
    throw Object.assign(new Error(`${path} answered ${res.status}`), {
      status: res.status,
    });
  }
  if (init.raw) return res;
  return res.status === 204 ? undefined : res.json();
}

/** A sprite or scan runs to the end before the answer: far past the default 5 s. */
const JOB_TIMEOUT_MS = 30 * 60_000;

/** The seek-bar sprite of a file, made by fliks-server; null when none could be made. */
export async function bridgeGenerateSprite(
  mediaFileId: number,
  opts: { force?: boolean; priority?: 'low' | 'normal' | 'high' } = {},
): Promise<SpriteMeta | null> {
  if (!bridgeConfigured()) return null;
  const meta = await bridgeFetch('/internal/jobs/sprite', {
    method: 'POST',
    body: { mediaFileId, ...opts },
    signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
  });
  return (meta as SpriteMeta | undefined) ?? null;
}

/** Scans the file's source unless it already was, in fliks-server; settles once the scan did. */
export async function bridgeScanSource(
  mediaFileId: number,
  priority?: 'low' | 'normal' | 'high',
): Promise<void> {
  if (!bridgeConfigured()) return;
  await bridgeFetch('/internal/scan/source', {
    method: 'POST',
    body: { mediaFileId, priority },
    signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
  });
}
