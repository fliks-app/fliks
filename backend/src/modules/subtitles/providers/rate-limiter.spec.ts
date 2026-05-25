import { getAllCooldowns, isRateLimited, rateLimitedFetch } from './rate-limiter';

describe('rate-limiter circuit breaker', () => {
  const PROVIDER = `test-${Math.random().toString(36).slice(2)}`;
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('opens the circuit after 3 consecutive 5xx responses', async () => {
    global.fetch = jest.fn(async () =>
      new Response(null, { status: 503 }),
    ) as unknown as typeof fetch;

    for (let i = 0; i < 3; i++) {
      await rateLimitedFetch(PROVIDER, 'https://example.test/path');
    }

    expect(isRateLimited(PROVIDER)).toBe(true);
    const state = getAllCooldowns().find((c) => c.providerType === PROVIDER);
    expect(state?.circuit).toBe('open');
    expect(state?.consecutiveFailures).toBeGreaterThanOrEqual(3);
  });

  it('opens the circuit on repeated network errors', async () => {
    const provider = `${PROVIDER}-net`;
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    for (let i = 0; i < 3; i++) {
      const res = await rateLimitedFetch(provider, 'https://example.test/x');
      expect(res).toBeNull();
    }

    expect(isRateLimited(provider)).toBe(true);
  });

  it('resets the breaker on a successful 2xx after failures', async () => {
    const provider = `${PROVIDER}-mix`;
    let firstCall = true;
    global.fetch = jest.fn(async () => {
      if (firstCall) {
        firstCall = false;
        return new Response(null, { status: 503 });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    await rateLimitedFetch(provider, 'https://example.test/y'); // 503
    let state = getAllCooldowns().find((c) => c.providerType === provider);
    expect(state?.consecutiveFailures).toBe(1);

    await rateLimitedFetch(provider, 'https://example.test/y'); // 200
    state = getAllCooldowns().find((c) => c.providerType === provider);
    // After success, the entry has zero failures + closed circuit, so
    // `getAllCooldowns` filters it out entirely. That's the assertion.
    expect(state).toBeUndefined();
  });
});
