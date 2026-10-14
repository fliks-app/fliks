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

/** Typed JSON calls to the control plane; `data` is set on a 2xx JSON reply only. */
export interface EngineClient {
  GET<P extends With<'get'>>(url: P): Reply<paths[P]['get']>;
  PUT<P extends With<'put'>>(
    url: P,
    init: { body: Json<paths[P]['put'], 'requestBody'> },
  ): Reply<paths[P]['put']>;
  POST<P extends With<'post'>>(
    url: P,
    init: { body: Json<paths[P]['post'], 'requestBody'> },
  ): Reply<paths[P]['post']>;
}

export function createEngineClient(
  baseUrl: string,
  token: string,
): EngineClient {
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(baseUrl.replace(/\/$/, '') + url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json =
      response.ok && response.headers.get('content-type')?.includes('json');
    return { data: json ? await response.json() : undefined, response };
  };
  return {
    GET: (url) => call('GET', url) as never,
    PUT: (url, init) => call('PUT', url, init.body) as never,
    POST: (url, init) => call('POST', url, init.body) as never,
  };
}
