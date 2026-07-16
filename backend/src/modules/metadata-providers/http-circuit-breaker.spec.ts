import axios, { AxiosInstance } from 'axios';
import { installCircuitBreaker, CircuitOpenError } from './http-circuit-breaker';

/** A failure with no HTTP response — a timeout/DNS/reset, which the breaker
 *  treats as transient. */
const transientError = () =>
  Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });

/** A real HTTP answer — must NOT trip the breaker. */
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status } });

const okResponse = (config: unknown) => ({
  data: { ok: true },
  status: 200,
  statusText: 'OK',
  headers: {},
  config,
});

describe('installCircuitBreaker', () => {
  let client: AxiosInstance;
  let calls: number;
  let behavior: (config: unknown) => Promise<unknown>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    calls = 0;
    behavior = () => Promise.reject(transientError());
    client = axios.create();
    // Stub the network so the interceptors are exercised in isolation.
    client.defaults.adapter = (config) => {
      calls += 1;
      return behavior(config) as never;
    };
    installCircuitBreaker(client, {
      name: 'test',
      failureThreshold: 3,
      cooldownMs: 30_000,
    });
  });

  afterEach(() => jest.useRealTimers());

  it('opens after the threshold, then fails fast without hitting the network', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(client.get('/x')).rejects.toBeDefined();
    }
    expect(calls).toBe(3);

    // Circuit open: rejects with CircuitOpenError and never reaches the adapter.
    await expect(client.get('/x')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(3);
  });

  it('probes after the cooldown and closes on the first success', async () => {
    for (let i = 0; i < 3; i++) await expect(client.get('/x')).rejects.toBeDefined();
    expect(calls).toBe(3);

    jest.setSystemTime(31_000); // past the cooldown
    behavior = (config) => Promise.resolve(okResponse(config));

    await expect(client.get('/x')).resolves.toMatchObject({ data: { ok: true } });
    expect(calls).toBe(4); // the probe reached the adapter

    // Closed again — subsequent calls pass straight through.
    await expect(client.get('/x')).resolves.toMatchObject({ data: { ok: true } });
    expect(calls).toBe(5);
  });

  it('ignores 4xx answers — a real response must not trip the breaker', async () => {
    behavior = () => Promise.reject(httpError(404));
    for (let i = 0; i < 5; i++) await expect(client.get('/x')).rejects.toBeDefined();
    expect(calls).toBe(5); // every call reached the adapter; breaker stayed closed
  });
});
