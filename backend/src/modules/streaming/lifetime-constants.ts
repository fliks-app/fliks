/**
 * Single tuning surface for streaming-session lifetimes: every env var that controls how long a
 * session, an ffmpeg job or a cache sweep lives, with its default. The engine gets them in
 * `PUT /v1/config` ({@link engineLifetime}); live TV, the dashboard and QoE read some directly.
 * Lazy reads keep the unit tests able to mutate process.env per-case.
 *
 * Cache retention and size live in Settings > Streaming, not here.
 */

const DEFAULT_LIVE_SESSION_TTL_MS = 30_000;
const DEFAULT_LIVE_SESSION_GC_INTERVAL_MS = 5_000;
const DEFAULT_SESSION_REVIVE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_SESSIONS_PER_USER = 10;
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
  sessionReviveTtlMs: (): number =>
    readEnvPositiveInt(
      'STREAM_SESSION_REVIVE_TTL_MS',
      DEFAULT_SESSION_REVIVE_TTL_MS,
    ),
  maxSessionsPerUser: (): number =>
    readEnvPositiveInt(
      'STREAM_MAX_SESSIONS_PER_USER',
      DEFAULT_MAX_SESSIONS_PER_USER,
    ),
  jobGraceMs: (): number =>
    readEnvPositiveInt('STREAM_JOB_GRACE_MS', DEFAULT_JOB_GRACE_MS),
  jobFallbackTimeoutMs: (): number =>
    readEnvPositiveInt(
      'STREAM_JOB_FALLBACK_TIMEOUT_MS',
      DEFAULT_JOB_FALLBACK_TIMEOUT_MS,
    ),
  cacheTtlMs: (): number => DEFAULT_CACHE_TTL_MS,
  cacheMaxBytes: (): number => DEFAULT_CACHE_MAX_BYTES,
  cacheGcIntervalMs: (): number =>
    readEnvPositiveInt(
      'TRANSCODE_CACHE_GC_INTERVAL_MS',
      DEFAULT_CACHE_GC_INTERVAL_MS,
    ),
} as const;

/** `EngineConfig.lifetime`: the env-tuned durations of the engine's sessions and jobs. */
export function engineLifetime() {
  return {
    liveSessionTtlMs: StreamLifetime.liveSessionTtlMs(),
    liveSessionGcIntervalMs: StreamLifetime.liveSessionGcIntervalMs(),
    sessionReviveTtlMs: StreamLifetime.sessionReviveTtlMs(),
    maxSessionsPerOwner: StreamLifetime.maxSessionsPerUser(),
    jobGraceMs: StreamLifetime.jobGraceMs(),
    jobFallbackTimeoutMs: StreamLifetime.jobFallbackTimeoutMs(),
    cacheGcIntervalMs: StreamLifetime.cacheGcIntervalMs(),
  };
}
