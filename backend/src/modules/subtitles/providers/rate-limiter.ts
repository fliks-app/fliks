import { Logger } from '@nestjs/common';

const log = new Logger('ProviderRateLimiter');

/** Number of consecutive non-429 network failures before the breaker
 *  opens. Picked low because subtitle providers are best-effort — when
 *  one is down it's better to skip than to slow every scheduler tick. */
const CIRCUIT_FAILURE_THRESHOLD = 3;
/** How long to keep the circuit open before letting one probe request
 *  through (half-open). 5 minutes balances "give the provider a chance
 *  to recover" against "don't hammer a struggling endpoint". */
const CIRCUIT_OPEN_MS = 5 * 60_000;

type CircuitState = 'closed' | 'open' | 'half-open';

interface ProviderCooldown {
  /** Timestamp (ms) when the rate-limit cooldown clears. */
  retryAfter: number;
  /** Remaining downloads in current window (provider-specific) */
  remaining: number | null;
  /** Count of back-to-back non-429 failures (5xx, network, timeout). */
  consecutiveFailures: number;
  /** Circuit state. Open = skip every call until `circuitResetAt`. */
  circuit: CircuitState;
  /** Timestamp (ms) at which the open circuit transitions to half-open. */
  circuitResetAt: number;
}

/** In-memory cooldown state per provider type */
const cooldowns = new Map<string, ProviderCooldown>();

function getOrCreate(providerType: string): ProviderCooldown {
  let cd = cooldowns.get(providerType);
  if (!cd) {
    cd = {
      retryAfter: 0,
      remaining: null,
      consecutiveFailures: 0,
      circuit: 'closed',
      circuitResetAt: 0,
    };
    cooldowns.set(providerType, cd);
  }
  return cd;
}

/** True when the circuit is currently blocking calls. */
function circuitOpen(providerType: string): boolean {
  const cd = cooldowns.get(providerType);
  if (!cd || cd.circuit === 'closed') return false;
  if (cd.circuit === 'open' && Date.now() >= cd.circuitResetAt) {
    cd.circuit = 'half-open';
    log.warn(
      `${providerType}: circuit half-open, letting one probe request through`,
    );
  }
  return cd.circuit === 'open';
}

/** Records a successful request — resets consecutive failures and
 *  closes a previously-open circuit. */
function recordSuccess(providerType: string): void {
  const cd = cooldowns.get(providerType);
  if (!cd) return;
  if (cd.circuit !== 'closed') {
    log.log(`${providerType}: circuit closed (recovered)`);
  }
  cd.consecutiveFailures = 0;
  cd.circuit = 'closed';
  cd.circuitResetAt = 0;
}

/** Records a network / 5xx failure. Opens the circuit once the threshold
 *  is crossed. 429/423 are handled separately via `markRateLimited` —
 *  rate-limiting is expected behaviour, not a breaker condition. */
function recordFailure(providerType: string, reason: string): void {
  const cd = getOrCreate(providerType);
  // A failure in half-open means the probe failed — re-open immediately.
  if (cd.circuit === 'half-open') {
    cd.circuit = 'open';
    cd.circuitResetAt = Date.now() + CIRCUIT_OPEN_MS;
    log.warn(`${providerType}: half-open probe failed (${reason}), re-opening`);
    return;
  }
  cd.consecutiveFailures += 1;
  if (cd.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    cd.circuit = 'open';
    cd.circuitResetAt = Date.now() + CIRCUIT_OPEN_MS;
    log.warn(
      `${providerType}: circuit OPEN after ${cd.consecutiveFailures} consecutive failures (${reason}); skipping for ${CIRCUIT_OPEN_MS / 60_000}min`,
    );
  }
}

/**
 * Check if a provider is currently rate-limited.
 * Returns the number of seconds to wait, or 0 if not limited.
 */
export function getRateLimitDelay(providerType: string): number {
  const cd = cooldowns.get(providerType);
  if (!cd) return 0;
  const now = Date.now();
  if (now >= cd.retryAfter) {
    // Clear the rate-limit but keep circuit / failure state intact —
    // those decay on their own via `recordSuccess` / `circuitOpen`.
    cd.retryAfter = 0;
    return 0;
  }
  return Math.ceil((cd.retryAfter - now) / 1000);
}

/**
 * Check if provider is unavailable to callers: either rate-limited or
 * with an open circuit. Either condition makes `rateLimitedFetch` skip.
 */
export function isRateLimited(providerType: string): boolean {
  return getRateLimitDelay(providerType) > 0 || circuitOpen(providerType);
}

/**
 * Mark a provider as rate-limited after receiving a 429/423 response.
 * Parses Retry-After header if available, otherwise uses default backoff.
 */
export function markRateLimited(
  providerType: string,
  response: Response | null,
  defaultBackoffSec = 60,
): void {
  let backoffSec = defaultBackoffSec;
  const cd = getOrCreate(providerType);

  if (response) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const parsed = Number(retryAfter);
      if (!isNaN(parsed)) {
        backoffSec = parsed;
      } else {
        // Retry-After can be a date string
        const date = new Date(retryAfter).getTime();
        if (!isNaN(date)) {
          backoffSec = Math.max(1, Math.ceil((date - Date.now()) / 1000));
        }
      }
    }

    // OpenSubtitles specific: X-RateLimit-Remaining-Second
    const remaining =
      response.headers.get('x-ratelimit-remaining-second') ??
      response.headers.get('ratelimit-remaining');
    if (remaining !== null) {
      cd.remaining = Number(remaining);
    }
  }

  log.warn(`${providerType} rate-limited, backing off ${backoffSec}s`);
  cd.retryAfter = Date.now() + backoffSec * 1000;
}

/**
 * Update remaining quota from response headers (non-blocking).
 * Call after every successful request to track quotas.
 */
export function trackQuota(providerType: string, response: Response): void {
  const remaining =
    response.headers.get('x-ratelimit-remaining-second') ??
    response.headers.get('ratelimit-remaining') ??
    response.headers.get('x-ratelimit-remaining');
  if (remaining !== null) {
    getOrCreate(providerType).remaining = Number(remaining);
  }
}

/**
 * Return current state for every provider that has at least one
 * non-default field (rate-limit cooldown, an open/half-open circuit,
 * or a non-zero remaining quota). Surfaces both rate-limit and
 * circuit-breaker conditions so an admin UI can show "Provider X is
 * skipped for 4 min — 3 consecutive failures".
 */
export function getAllCooldowns(): {
  providerType: string;
  retryAfter: number;
  remaining: number | null;
  delaySec: number;
  circuit: CircuitState;
  circuitResetAt: number;
  circuitResetInSec: number;
  consecutiveFailures: number;
}[] {
  const now = Date.now();
  const result: {
    providerType: string;
    retryAfter: number;
    remaining: number | null;
    delaySec: number;
    circuit: CircuitState;
    circuitResetAt: number;
    circuitResetInSec: number;
    consecutiveFailures: number;
  }[] = [];
  for (const [providerType, cd] of cooldowns) {
    const rateLimited = now < cd.retryAfter;
    const breaker = cd.circuit !== 'closed';
    if (!rateLimited && !breaker && cd.consecutiveFailures === 0) continue;
    result.push({
      providerType,
      retryAfter: cd.retryAfter,
      remaining: cd.remaining,
      delaySec: rateLimited ? Math.ceil((cd.retryAfter - now) / 1000) : 0,
      circuit: cd.circuit,
      circuitResetAt: cd.circuitResetAt,
      circuitResetInSec:
        breaker && cd.circuitResetAt > now
          ? Math.ceil((cd.circuitResetAt - now) / 1000)
          : 0,
      consecutiveFailures: cd.consecutiveFailures,
    });
  }
  return result;
}

/**
 * Wrapper for fetch that handles rate-limiting AND circuit-breaker
 * state automatically:
 *  - Skips the call when rate-limited or with an open circuit.
 *  - Records success / failure so the breaker reacts to repeated
 *    network errors or 5xx responses.
 *  - Returns null in any skip case (caller should treat as empty
 *    results — providers' contract is best-effort).
 */
export async function rateLimitedFetch(
  providerType: string,
  url: string,
  init?: RequestInit,
  opts?: { maxRetries?: number; defaultBackoffSec?: number },
): Promise<Response | null> {
  if (isRateLimited(providerType)) return null;

  const maxRetries = opts?.maxRetries ?? 2;
  const defaultBackoff = opts?.defaultBackoffSec ?? 60;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Network error (DNS, TLS, ECONNRESET, timeout, …). Don't retry
      // here — let the breaker decide if subsequent calls should be
      // skipped wholesale.
      recordFailure(providerType, `network: ${(err as Error).message}`);
      return null;
    }

    if (res.status === 429 || res.status === 423) {
      markRateLimited(providerType, res, defaultBackoff);
      if (attempt < maxRetries) {
        const delay = getRateLimitDelay(providerType);
        if (attempt === 0) {
          log.warn(
            `${providerType} rate-limited (${res.status}), retrying ${maxRetries} time(s)...`,
          );
        }
        await new Promise((r) => setTimeout(r, Math.min(delay, 10) * 1000));
        continue;
      }
      return null;
    }

    if (res.status >= 500) {
      recordFailure(providerType, `http ${res.status}`);
      return res;
    }

    // 2xx / 3xx / 4xx (other than 429/423): the request reached the
    // provider, so the circuit is healthy. 4xx is the caller's problem,
    // not the provider's.
    recordSuccess(providerType);
    trackQuota(providerType, res);
    return res;
  }

  return null;
}

/**
 * Wraps a non-fetch provider operation (auth call, manual `fetch` that
 * predates `rateLimitedFetch`) so it participates in circuit-breaker
 * state. Use when a provider has its own networking and we just want
 * the failure-counting semantics.
 */
export async function withCircuitBreaker<T>(
  providerType: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (isRateLimited(providerType)) return null;
  try {
    const result = await fn();
    recordSuccess(providerType);
    return result;
  } catch (err) {
    recordFailure(providerType, (err as Error).message);
    throw err;
  }
}
