/**
 * Single tuning surface for streaming-session lifetimes. Every env
 * var that controls how long a live session, a transcode job or a
 * cache entry survives is declared here, with its default. Services
 * read the matching getter on instantiation — lazy reads keep the
 * unit tests able to mutate process.env per-case.
 *
 *   STREAM_LIVE_SESSION_TTL_MS         live-session.service.ts
 *   STREAM_LIVE_SESSION_GC_INTERVAL_MS live-session.service.ts
 *   STREAM_JOB_GRACE_MS                transcoding/constants.ts
 *   STREAM_JOB_FALLBACK_TIMEOUT_MS     transcoding/constants.ts
 *   TRANSCODE_CACHE_TTL_MS             transcode-cache.service.ts
 *   TRANSCODE_CACHE_MAX_BYTES          transcode-cache.service.ts
 *   TRANSCODE_CACHE_GC_INTERVAL_MS     transcode-cache.service.ts
 */

const DEFAULT_LIVE_SESSION_TTL_MS = 30_000;
const DEFAULT_LIVE_SESSION_GC_INTERVAL_MS = 5_000;
const DEFAULT_JOB_GRACE_MS = 60_000;
const DEFAULT_JOB_FALLBACK_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_CACHE_MAX_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_CACHE_GC_INTERVAL_MS = 5 * 60 * 1000;

function readEnvPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const StreamLifetime = {
  liveSessionTtlMs: (): number =>
    readEnvPositiveInt('STREAM_LIVE_SESSION_TTL_MS', DEFAULT_LIVE_SESSION_TTL_MS),
  liveSessionGcIntervalMs: (): number =>
    readEnvPositiveInt(
      'STREAM_LIVE_SESSION_GC_INTERVAL_MS',
      DEFAULT_LIVE_SESSION_GC_INTERVAL_MS,
    ),
  jobGraceMs: (): number =>
    readEnvPositiveInt('STREAM_JOB_GRACE_MS', DEFAULT_JOB_GRACE_MS),
  jobFallbackTimeoutMs: (): number =>
    readEnvPositiveInt(
      'STREAM_JOB_FALLBACK_TIMEOUT_MS',
      DEFAULT_JOB_FALLBACK_TIMEOUT_MS,
    ),
  cacheTtlMs: (): number =>
    readEnvPositiveInt('TRANSCODE_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS),
  cacheMaxBytes: (): number =>
    readEnvPositiveInt('TRANSCODE_CACHE_MAX_BYTES', DEFAULT_CACHE_MAX_BYTES),
  cacheGcIntervalMs: (): number =>
    readEnvPositiveInt(
      'TRANSCODE_CACHE_GC_INTERVAL_MS',
      DEFAULT_CACHE_GC_INTERVAL_MS,
    ),
} as const;
