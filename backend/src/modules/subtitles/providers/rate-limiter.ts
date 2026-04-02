import { Logger } from '@nestjs/common';

const log = new Logger('ProviderRateLimiter');

interface ProviderCooldown {
  /** Timestamp (ms) when the provider can be used again */
  retryAfter: number;
  /** Remaining downloads in current window (provider-specific) */
  remaining: number | null;
}

/** In-memory cooldown state per provider type */
const cooldowns = new Map<string, ProviderCooldown>();

/**
 * Check if a provider is currently rate-limited.
 * Returns the number of seconds to wait, or 0 if not limited.
 */
export function getRateLimitDelay(providerType: string): number {
  const cd = cooldowns.get(providerType);
  if (!cd) return 0;
  const now = Date.now();
  if (now >= cd.retryAfter) {
    cooldowns.delete(providerType);
    return 0;
  }
  return Math.ceil((cd.retryAfter - now) / 1000);
}

/**
 * Check if provider is rate-limited. If so, log a warning and return true.
 */
export function isRateLimited(providerType: string): boolean {
  return getRateLimitDelay(providerType) > 0;
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
    const remaining = response.headers.get('x-ratelimit-remaining-second')
      ?? response.headers.get('ratelimit-remaining');
    if (remaining !== null) {
      const cd = cooldowns.get(providerType) ?? { retryAfter: 0, remaining: null };
      cd.remaining = Number(remaining);
      cooldowns.set(providerType, cd);
    }
  }

  log.warn(`${providerType} rate-limited, backing off ${backoffSec}s`);
  cooldowns.set(providerType, {
    retryAfter: Date.now() + backoffSec * 1000,
    remaining: cooldowns.get(providerType)?.remaining ?? null,
  });
}

/**
 * Update remaining quota from response headers (non-blocking).
 * Call after every successful request to track quotas.
 */
export function trackQuota(providerType: string, response: Response): void {
  const remaining = response.headers.get('x-ratelimit-remaining-second')
    ?? response.headers.get('ratelimit-remaining')
    ?? response.headers.get('x-ratelimit-remaining');
  if (remaining !== null) {
    const cd = cooldowns.get(providerType) ?? { retryAfter: 0, remaining: null };
    cd.remaining = Number(remaining);
    cooldowns.set(providerType, cd);
  }
}

/**
 * Wrapper for fetch that handles rate-limiting automatically.
 * Returns null if rate-limited (caller should return empty results).
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
    const res = await fetch(url, init);

    if (res.status === 429 || res.status === 423) {
      markRateLimited(providerType, res, defaultBackoff);
      if (attempt < maxRetries) {
        const delay = getRateLimitDelay(providerType);
        if (attempt === 0) {
          log.warn(`${providerType} rate-limited (${res.status}), retrying ${maxRetries} time(s)...`);
        }
        await new Promise((r) => setTimeout(r, Math.min(delay, 10) * 1000));
        continue;
      }
      return null;
    }

    trackQuota(providerType, res);
    return res;
  }

  return null;
}
