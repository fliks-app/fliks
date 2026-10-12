import type { QoeEngine, QoeEvent, QoeEventType, QoeSample } from './types';

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
];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v ? v.slice(0, max) : null;

const bool = (v: unknown): boolean | null =>
  typeof v === 'boolean' ? v : null;

/** A heartbeat `qoe` block with unknown fields dropped; null when unusable. */
export function parseSample(raw: unknown): QoeSample | null {
  if (!isObj(raw) || !ENGINES.includes(raw.engine as QoeEngine)) return null;
  return {
    engine: raw.engine as QoeEngine,
    cmcd: raw.cmcd === true,
    droppedFrames: num(raw.droppedFrames),
    decodedFrames: num(raw.decodedFrames),
    bandwidthBps: num(raw.bandwidthBps),
    bufferAheadS: num(raw.bufferAheadS),
    variantBitrate: num(raw.variantBitrate),
    width: num(raw.width),
    height: num(raw.height),
    videoCodec: str(raw.videoCodec, 64),
    decoderName: str(raw.decoderName, 128),
    hwDecoder: bool(raw.hwDecoder),
    stallCount: num(raw.stallCount) ?? 0,
    stallMs: num(raw.stallMs) ?? 0,
    recoveryReloads: num(raw.recoveryReloads) ?? 0,
  };
}

/** Valid events from a request body, at most {@link MAX_EVENTS_PER_REQUEST}. */
export function parseEvents(raw: unknown): QoeEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: QoeEvent[] = [];
  for (const e of raw.slice(0, MAX_EVENTS_PER_REQUEST)) {
    if (!isObj(e) || !EVENT_TYPES.includes(e.type as QoeEventType)) continue;
    const at = num(e.at);
    if (at == null) continue;
    const ev: QoeEvent = {
      type: e.type as QoeEventType,
      at,
      position: num(e.position),
    };
    const durationMs = num(e.durationMs);
    if (durationMs != null) ev.durationMs = durationMs;
    if ('bufferAheadS' in e) ev.bufferAheadS = num(e.bufferAheadS);
    if ('bandwidthBps' in e) ev.bandwidthBps = num(e.bandwidthBps);
    if (typeof e.code === 'number' && Number.isFinite(e.code)) ev.code = e.code;
    const message = str(e.message, 300);
    if (message) ev.message = message;
    const category = str(e.category, 64);
    if (category) ev.category = category;
    const from = num(e.fromBitrate);
    if (from != null) ev.fromBitrate = from;
    const to = num(e.toBitrate);
    if (to != null) ev.toBitrate = to;
    out.push(ev);
  }
  return out;
}
