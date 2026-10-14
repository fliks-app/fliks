import type { paths } from './schema';

type With<M extends string> = {
  [P in keyof paths]: paths[P] extends Record<M, unknown> ? P : never;
}[keyof paths];
type Json<O, K extends 'requestBody' | 'responses'> = O extends {
  [k in K]: infer R;
}
  ? R extends { content: { 'application/json': infer D } }
    ? D
    : R extends { 200: { content: { 'application/json': infer D } } }
      ? D
      : never
  : never;
type Reply<O> = Promise<{ data?: Json<O, 'responses'>; response: Response }>;

/** `{sid}` placeholders of the route and its query string; the generated types do not model them. */
export interface Params {
  path?: Record<string, string | number>;
  query?: Record<string, string | number | undefined>;
}

/** Typed JSON calls to the control plane; `data` is set on a 2xx JSON reply only. */
export interface EngineClient {
  GET<P extends With<'get'>>(url: P, init?: Params): Reply<paths[P]['get']>;
  PUT<P extends With<'put'>>(
    url: P,
    init: Params & { body: Json<paths[P]['put'], 'requestBody'> },
  ): Reply<paths[P]['put']>;
  POST<P extends With<'post'>>(
    url: P,
    init: Params & { body: Json<paths[P]['post'], 'requestBody'> },
  ): Reply<paths[P]['post']>;
  DELETE<P extends With<'delete'>>(
    url: P,
    init?: Params,
  ): Reply<paths[P]['delete']>;
  /** The raw response of a long-lived GET (SSE), aborted through `signal`. */
  stream(url: '/v1/events', signal: AbortSignal): Promise<Response>;
}

function expand(url: string, { path, query }: Params = {}): string {
  const full = url.replace(/\{(\w+)\}/g, (_, k: string) =>
    encodeURIComponent(String(path?.[k])),
  );
  const qs = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined)
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
    )
    .join('&');
  return qs ? `${full}?${qs}` : full;
}

export function createEngineClient(
  baseUrl: string,
  token: string,
): EngineClient {
  const base = baseUrl.replace(/\/$/, '');
  const call = async (
    method: string,
    url: string,
    params?: Params,
    body?: unknown,
    signal?: AbortSignal,
  ) => {
    const response = await fetch(base + expand(url, params), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const json =
      response.ok && response.headers.get('content-type')?.includes('json');
    return { data: json ? await response.json() : undefined, response };
  };
  return {
    GET: (url, init) => call('GET', url, init) as never,
    PUT: (url, init) => call('PUT', url, init, init.body) as never,
    POST: (url, init) => call('POST', url, init, init.body) as never,
    DELETE: (url, init) => call('DELETE', url, init) as never,
    stream: (url, signal) =>
      fetch(base + url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
        signal,
      }),
  };
}
