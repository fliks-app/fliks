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
});
