import { AxiosError, AxiosInstance } from 'axios';
import { Logger } from '@nestjs/common';

/** Thrown by the breaker while the circuit is open, so callers fail instantly
 *  instead of waiting out the socket timeout. */
export class CircuitOpenError extends Error {
  readonly isCircuitOpen = true;
  constructor(name: string) {
    super(`${name} circuit open — upstream temporarily unreachable`);
    this.name = 'CircuitOpenError';
  }
}

/** A missing HTTP response (timeout, DNS, refused, reset) or an upstream that is
 *  itself failing (rate-limit / 5xx) is transient; a 4xx is a real answer. */
function isTransient(error: AxiosError): boolean {
  if (!error.response) return true;
  const status = error.response.status;
  return status === 429 || status >= 500;
}

/**
 * Fail-fast circuit breaker for an outbound axios client, installed as
 * interceptors so every request is covered without touching call sites.
 *
 * After `failureThreshold` consecutive transient failures the circuit opens for
 * `cooldownMs`: requests then reject immediately with {@link CircuitOpenError}
 * rather than each hanging on the socket timeout. This is what turns an upstream
 * outage from an app-wide stall — and a background refresh loop that reprobes a
 * dead host on every item — into a cheap, immediate failure. The first request
 * after the cooldown probes the upstream; any success closes the circuit.
 */
export function installCircuitBreaker(
  client: AxiosInstance,
  opts: { name: string; failureThreshold: number; cooldownMs: number },
): void {
  const logger = new Logger(`CircuitBreaker:${opts.name}`);
  let failures = 0;
  let openUntil = 0;

  client.interceptors.request.use((config) => {
    if (Date.now() < openUntil) throw new CircuitOpenError(opts.name);
    return config;
  });

  client.interceptors.response.use(
    (response) => {
      if (failures > 0) {
        failures = 0;
        logger.log('upstream recovered — circuit closed');
      }
      return response;
    },
    (error: AxiosError) => {
      if (isTransient(error)) {
        failures += 1;
        if (failures >= opts.failureThreshold && Date.now() >= openUntil) {
          openUntil = Date.now() + opts.cooldownMs;
          logger.warn(
            `${failures} consecutive failures — circuit open for ${Math.round(
              opts.cooldownMs / 1000,
            )}s`,
          );
        }
      }
      throw error;
    },
  );
}
