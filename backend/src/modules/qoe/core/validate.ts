import type { QoeEngine, QoeEvent, QoeEventType, QoeReloadReason, QoeSample } from './types';

export const MAX_EVENTS_PER_REQUEST = 50;

const ENGINES: readonly QoeEngine[] = [
  'shaka',
  'exoplayer',
  'avplayer',
  'mpv',
  'avplay',
  'webos',
  'cast',
];
const EVENT_TYPES: readonly QoeEventType[] = [
  'stall',
  'error',
  'recovery',
  'quality_switch',
  'reload',
];
const RELOAD_REASONS: readonly QoeReloadReason[] = [
  'audio',
  'subtitles',
  'quality',
  'remux_fallback',
  'other',
];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

const INT_MAX = 2 ** 31 - 1;
const DAY_MS = 86_400_000;

/** For integer DB columns: a fraction or huge value would make every upsert throw. */
const int = (v: unknown): number | null => {
  const n = num(v);
  return n == null ? null : Math.min(Math.round(n), INT_MAX);
};

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v ? v.slice(0, max) : null;

const bool = (v: unknown): boolean | null =>
  typeof v === 'boolean' ? v : null;

/** Client-generated id of one viewing; anything else is ignored. */
export function parsePlaybackId(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}

/** The client epoch ms an events batch was sent at; anything else is ignored. */
export const parseSentAt = num;

/** A heartbeat `qoe` block with unknown fields dropped; null when unusable. */
export function parseSample(raw: unknown): QoeSample | null {
  if (!isObj(raw) || !ENGINES.includes(raw.engine as QoeEngine)) return null;
  return {
    engine: raw.engine as QoeEngine,
    cmcd: raw.cmcd === true,
    droppedFrames: int(raw.droppedFrames),
    decodedFrames: int(raw.decodedFrames),
    bandwidthBps: num(raw.bandwidthBps),
    bufferAheadS: num(raw.bufferAheadS),
    variantBitrate: num(raw.variantBitrate),
    width: int(raw.width),
    height: int(raw.height),
    videoCodec: str(raw.videoCodec, 64),
    decoderName: str(raw.decoderName, 128),
    hwDecoder: bool(raw.hwDecoder),
    stallCount: int(raw.stallCount) ?? 0,
    stallMs: int(raw.stallMs) ?? 0,
    recoveryReloads: int(raw.recoveryReloads) ?? 0,
    playbackId: parsePlaybackId(raw.playbackId),
  };
}

/** Valid events from a request body, at most {@link MAX_EVENTS_PER_REQUEST}. */
export function parseEvents(
  raw: unknown,
  now = Date.now(),
  sentAt: number | null = null,
): QoeEvent[] {
  if (!Array.isArray(raw)) return [];
  // The client's clock offset, taken from the batch send time.
  const skew = sentAt != null && Math.abs(now - sentAt) <= DAY_MS ? now - sentAt : 0;
  const out: QoeEvent[] = [];
  for (const e of raw.slice(0, MAX_EVENTS_PER_REQUEST)) {
    if (!isObj(e) || !EVENT_TYPES.includes(e.type as QoeEventType)) continue;
    const raw = num(e.at);
    const clientAt = raw == null ? null : raw + skew;
    const ev: QoeEvent = {
      type: e.type as QoeEventType,
      at:
        clientAt != null && Math.abs(clientAt - now) <= DAY_MS ? clientAt : now,
      position: num(e.position),
    };
    const durationMs = num(e.durationMs);
    if (durationMs != null) ev.durationMs = durationMs;
    const buffer = num(e.bufferAheadS);
    if (buffer != null) ev.bufferAheadS = buffer;
    const bandwidth = num(e.bandwidthBps);
    if (bandwidth != null) ev.bandwidthBps = bandwidth;
    if (typeof e.code === 'number' && Number.isFinite(e.code)) ev.code = e.code;
    const message = str(e.message, 300);
    if (message) ev.message = message;
    const category = str(e.category, 64);
    if (category) ev.category = category;
    const from = num(e.fromBitrate);
    if (from != null) ev.fromBitrate = from;
    const to = num(e.toBitrate);
    if (to != null) ev.toBitrate = to;
    const variant = num(e.variantBitrate);
    if (variant != null) ev.variantBitrate = variant;
    if (ev.type === 'reload') {
      ev.reason = RELOAD_REASONS.includes(e.reason as QoeReloadReason)
        ? (e.reason as QoeReloadReason)
        : 'other';
      const rFrom = str(e.from, 80);
      if (rFrom) ev.from = rFrom;
      const rTo = str(e.to, 80);
      if (rTo) ev.to = rTo;
    }
    out.push(ev);
  }
  return out;
}
