import { Injectable, Logger } from '@nestjs/common';
import { Indexer } from './entities/indexer.entity';

/**
 * Serialises requests to each indexer and enforces a minimum delay
 * between them, mirroring Prowlarr's per-indexer throttle. Public
 * tracker portals (especially behind Cloudflare anti-DDoS) IP-ban
 * clients that exceed their tolerance; this layer is what keeps the
 * scheduler — which fans out across hundreds of medias — within those
 * limits.
 *
 * Three protection mechanisms layered together:
 *   1. Per-indexer serial queue — only one in-flight request at a
 *      time. Cross-indexer calls remain parallel.
 *   2. Minimum `requestDelay` (seconds) between the START of two
 *      consecutive requests for the same indexer.
 *   3. `Retry-After` window — when a 429/503 surfaces the header,
 *      subsequent calls block until the window elapses; this overrides
 *      `requestDelay` upward, never downward.
 *   4. Progressive cooldown on consecutive failures — 30s → 2min →
 *      15min → 1h → 6h. Resets on success.
 */
@Injectable()
export class IndexerThrottle {
  private readonly log = new Logger(IndexerThrottle.name);
  /** Tail of the per-indexer promise chain. Awaiting it serialises
   *  the next operation behind all currently-queued ones. */
  private chains = new Map<number, Promise<unknown>>();
  /** Earliest wall-clock ms a new request to this indexer is allowed
   *  to start. Updated post-request (current + delay) AND on
   *  Retry-After (current + retry window). */
  private nextAllowedAt = new Map<number, number>();
  /** Consecutive failure count — drives progressive cooldown. */
  private failureCount = new Map<number, number>();

  /** Queue `fn` against `indexer`. Returns whatever `fn` resolves to.
   *  Rejections propagate untouched (so callers can pattern-match on
   *  axios errors), but failure metadata is recorded for backoff. */
  async run<T>(indexer: Indexer, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(indexer.id) ?? Promise.resolve();
    const current = prev.then(() => this.runOne(indexer, fn));
    // Swallow rejections at the chain level so a single failure
    // doesn't poison every queued follower with an unhandled-rejection
    // error. The caller still sees the rejection through its own
    // `await current`.
    this.chains.set(
      indexer.id,
      current.catch(() => undefined),
    );
    return current;
  }

  private async runOne<T>(indexer: Indexer, fn: () => Promise<T>): Promise<T> {
    const delayMs = Math.max(0, indexer.requestDelay ?? 2) * 1000;
    const earliest = this.nextAllowedAt.get(indexer.id) ?? 0;
    const wait = earliest - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const result = await fn();
      this.notifySuccess(indexer.id);
      this.nextAllowedAt.set(indexer.id, Date.now() + delayMs);
      return result;
    } catch (e) {
      this.nextAllowedAt.set(indexer.id, Date.now() + delayMs);
      throw e;
    }
  }

  /** Honour a `Retry-After` value (in seconds OR an absolute date).
   *  Caller passes whatever the response header carried. */
  setRetryAfter(indexer: Indexer, headerValue: string | undefined): void {
    const ms = parseRetryAfter(headerValue);
    if (ms <= 0) return;
    const until = Date.now() + ms;
    const current = this.nextAllowedAt.get(indexer.id) ?? 0;
    if (until > current) this.nextAllowedAt.set(indexer.id, until);
    this.log.warn(
      `[${indexer.name}] Retry-After honoured — next request in ${Math.round(ms / 1000)}s`,
    );
  }

  /** Caller signals a transport-level failure (network error, 5xx,
   *  429 even after Retry-After). Drives progressive cooldown. */
  notifyFailure(indexer: Indexer): void {
    const n = (this.failureCount.get(indexer.id) ?? 0) + 1;
    this.failureCount.set(indexer.id, n);
    const cooldownMs = backoffFor(n);
    if (cooldownMs <= 0) return;
    const until = Date.now() + cooldownMs;
    const current = this.nextAllowedAt.get(indexer.id) ?? 0;
    if (until > current) this.nextAllowedAt.set(indexer.id, until);
    this.log.warn(
      `[${indexer.name}] consecutive failure #${n} — cooldown ${Math.round(cooldownMs / 1000)}s`,
    );
  }

  /** Reset the backoff state for an indexer on confirmed success. */
  notifySuccess(indexerId: number): void {
    this.failureCount.delete(indexerId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * RFC 7231 §7.1.3: `Retry-After` is either a delta-seconds integer or
 * an HTTP-date. Returns the wait in milliseconds; 0 if unparseable.
 */
function parseRetryAfter(value: string | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  const ts = Date.parse(trimmed);
  if (!isNaN(ts)) {
    return Math.max(0, ts - Date.now());
  }
  return 0;
}

/**
 * Progressive cooldown after consecutive failures. Caps at 6h so a
 * permanently-broken indexer doesn't waste cycles but still
 * occasionally probes for recovery.
 */
function backoffFor(failureCount: number): number {
  const steps = [
    30_000,        // 1st failure → 30s
    2 * 60_000,    // 2nd        → 2 min
    15 * 60_000,   // 3rd        → 15 min
    60 * 60_000,   // 4th        → 1 h
    6 * 60 * 60_000, // 5th+    → 6 h
  ];
  return steps[Math.min(failureCount, steps.length) - 1] ?? 0;
}
