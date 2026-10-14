import { createEngineClient } from './engine-client';

describe('createEngineClient', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sends the bearer token and a JSON body, and returns the JSON reply', async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    global.fetch = fetchMock as never;
    const client = createEngineClient('http://127.0.0.1:1/', 'tok');

    const { data } = await client.POST('/v1/probe', {
      body: { media: { mediaFileId: 0, path: '/a.mkv' } },
    });

    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:1/v1/probe', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tok',
        'Content-Type': 'application/json',
      },
      body: '{"media":{"mediaFileId":0,"path":"/a.mkv"}}',
    });
  });

  it('leaves data unset on a non-2xx reply', async () => {
    global.fetch = (async () =>
      new Response(null, {
        status: 503,
        headers: { 'Retry-After': '1' },
      })) as never;
    const { data, response } = await createEngineClient('http://x', 't').GET(
      '/v1/capabilities',
    );
    expect(data).toBeUndefined();
    expect(response.status).toBe(503);
  });

  it('fills the path placeholders and the query string, and drops unset query values', async () => {
    const fetchMock = jest.fn(async () => new Response(null, { status: 204 }));
    global.fetch = fetchMock as never;
    const client = createEngineClient('http://x', 't');

    await client.DELETE('/v1/sessions/{sid}', { path: { sid: 'a/b c' }, query: { reason: 'stopped', other: undefined } });
    await client.GET('/v1/sessions', { query: { ownerId: '7', mediaFileId: 3 } });

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://x/v1/sessions/a%2Fb%20c?reason=stopped', expect.objectContaining({ method: 'DELETE' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://x/v1/sessions?ownerId=7&mediaFileId=3', expect.objectContaining({ method: 'GET' }));
  });

  it('streams the events with the bearer token and the caller\'s abort signal', async () => {
    const fetchMock = jest.fn(async () => new Response('x'));
    global.fetch = fetchMock as never;
    const ac = new AbortController();

    await createEngineClient('http://x/', 't').stream('/v1/events', ac.signal);

    expect(fetchMock).toHaveBeenCalledWith('http://x/v1/events', {
      headers: { Authorization: 'Bearer t', Accept: 'text/event-stream' },
      signal: ac.signal,
    });
  });
});
