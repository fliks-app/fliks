import type { QoeEventRow, QoePipeline, QoeServerLoad, QoeStallCause } from '../../core/services/api/qoe-api.service';
import { QOE_VERDICT_BAR_CLASS } from './qoe-health';

export const QOE_CAUSES: readonly QoeStallCause[] = ['server', 'network', 'device', 'unknown'];

/** The verdict palette, so a cause and the verdict of the same name never differ in colour. */
export const QOE_CAUSE_DOT_CLASS: Record<QoeStallCause, string> = {
  server: QOE_VERDICT_BAR_CLASS.server,
  network: QOE_VERDICT_BAR_CLASS.network,
  device: QOE_VERDICT_BAR_CLASS.device,
  unknown: QOE_VERDICT_BAR_CLASS.unknown,
};

/** Translation and number formatting in the admin's language. */
export interface Fmt {
  t(key: string, params?: Record<string, string>): string;
  n(v: number, digits?: number): string;
}

const plain = (v: number, digits = 1) => v.toFixed(digits);

/** The translated line of a stall: the reason key and the evidence numbers it interpolates. */
export function stallExplanation(
  e: Pick<QoeEventRow, 'data'>,
  n: Fmt['n'] = plain,
): { key: string; params: Record<string, string> } | null {
  const d = e.data;
  if (!d?.cause || !d.causeReason) return null;
  const ev = d.causeEvidence ?? {};
  const mbps = (bps: number | undefined) => (bps == null ? '-' : n(bps / 1_000_000, 1));
  return {
    key: d.causeReason,
    params: {
      buffer: ev['bufferAheadS'] == null ? '-' : n(ev['bufferAheadS'], 1),
      throughput: mbps(ev['bandwidthBps']),
      bitrate: mbps(ev['variantBitrate']),
      wait: ev['waitedMs'] == null ? '-' : n(ev['waitedMs'] / 1000, 1),
      speed: ev['transcodeSpeed'] == null ? '-' : n(ev['transcodeSpeed'], 1),
      dropped: ev['droppedPct'] == null ? '-' : n(ev['droppedPct'], 0),
    },
  };
}

export interface StallCauseTotal {
  cause: QoeStallCause;
  count: number;
  ms: number;
}

/** Count and total duration per cause over the classified stalls; empty when none was classified. */
export function stallBreakdown(events: Pick<QoeEventRow, 'type' | 'data'>[]): StallCauseTotal[] {
  const totals = new Map<QoeStallCause, StallCauseTotal>();
  for (const e of events) {
    const cause = e.type === 'stall' ? e.data?.cause : undefined;
    if (!cause) continue;
    const t = totals.get(cause) ?? { cause, count: 0, ms: 0 };
    t.count++;
    t.ms += e.data?.durationMs ?? 0;
    totals.set(cause, t);
  }
  return QOE_CAUSES.flatMap((c) => totals.get(c) ?? []);
}

/** A duration as a translation key and its numbers: "2 min 09 s", never "2:09", which reads as a position. */
export function durationParts(ms: number): { key: string; params: Record<string, string> } {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return { key: 'qoe.duration_h', params: { h: String(h), min: String(min) } };
  if (min > 0) return { key: 'qoe.duration_min', params: { min: String(min), sec: String(sec).padStart(2, '0') } };
  return { key: 'qoe.duration_s', params: { sec: String(sec) } };
}

/** When the event began: a stall is reported at its end, so its start is `at - durationMs`. */
export function eventStartMs(e: Pick<QoeEventRow, 'at' | 'type' | 'data'>): number {
  const at = typeof e.at === 'number' ? e.at : Date.parse(e.at);
  return e.type === 'stall' ? at - (e.data?.durationMs ?? 0) : at;
}

const CODEC_LABEL: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  mpeg2video: 'MPEG-2',
  vc1: 'VC-1',
  vp9: 'VP9',
};

export const codecLabel = (c: string | null | undefined) => (c ? (CODEC_LABEL[c.toLowerCase()] ?? c.toUpperCase()) : '');

function resolutionLabel(height: number | null, f: Fmt): string {
  if (height == null) return '';
  return f.t('qoe.pipeline.res_p', { height: String(height) });
}

const join = (xs: (string | null | undefined | false)[]) => xs.filter((x): x is string => !!x).join(' ');

const HDR_LABEL: Record<string, string> = { DV: 'Dolby Vision' };

const dimensions = (d: { width: number | null; height: number | null } | null | undefined) =>
  d?.width && d.height ? `${d.width}×${d.height}` : '';

/**
 * "3840×1588 HEVC HDR10 → auto → 3840×1588 (tier 2160p) H.264 8.0 Mbps", or just the source when the stream is
 * not re-encoded. The output shows the real dimensions when known, and the rung as a tier name, so a scope film
 * is never read as an upscale.
 */
export function pipelineChain(p: QoePipeline, f: Fmt, outDims?: { width: number | null; height: number | null } | null): string {
  const s = p.source;
  const src = s ? join([dimensions(s) || resolutionLabel(s.height, f), codecLabel(s.codec), s.hdr && (HDR_LABEL[s.hdr] ?? s.hdr)]) : '';
  const o = p.output;
  const rung = o?.quality && !['auto', 'original', 'remux'].includes(o.quality) ? o.quality.replace(/-hdr$/, '') : '';
  const tier = rung ? f.t('qoe.pipeline.rung', { name: rung }) : '';
  const dims = dimensions(outDims);
  const size = dims ? join([dims, tier && `(${tier})`]) : tier;
  const rate = o?.bitrate ? f.t('qoe.mbps', { value: f.n(o.bitrate / 1_000_000, 1) }) : '';
  const auto = o?.requested === 'auto' ? `${f.t('qoe.pipeline.auto')} →` : '';
  const out = o ? join([auto, size, codecLabel(o.codec), o.hdr, rate]) : '';
  return src && out ? `${src} → ${out}` : src || out;
}

/** "auto → 2160p" when the client left the choice to the server, else the requested rung. */
export function qualityLabel(
  row: { quality: string | null; pipeline?: QoePipeline | null },
  f: Fmt,
): string {
  const served = row.pipeline?.output?.quality?.replace(/-hdr$/, '') ?? '';
  const req = row.quality ?? row.pipeline?.output?.requested ?? null;
  if (!req) return served || '-';
  if (req === 'auto') return served ? `${f.t('qoe.pipeline.auto')} → ${served}` : f.t('qoe.pipeline.auto');
  return req;
}

export interface PipelinePart {
  key: string;
  params: Record<string, string>;
}

const upper = (kind: string) => kind.toUpperCase();

/** The stages after the chain, each a translation key: decode, encode, tonemap, burn-in, crop, audio. */
export function pipelineParts(p: QoePipeline): PipelinePart[] {
  const parts: PipelinePart[] = [];
  if (p.tonemap) parts.push({ key: 'qoe.pipeline.tonemap', params: { path: p.tonemap === 'opencl' ? 'OpenCL' : p.tonemap === 'videotoolbox' ? 'VideoToolbox' : upper(p.tonemap) } });
  if (p.decode) parts.push({ key: 'qoe.pipeline.decode', params: { kind: upper(p.decode.kind) } });
  if (p.encode) parts.push({ key: 'qoe.pipeline.encode', params: { kind: upper(p.encode.kind) } });
  if (p.burnIn) parts.push({ key: `qoe.pipeline.burn_in_${p.burnIn}`, params: {} });
  if (p.crop) parts.push({ key: 'qoe.pipeline.crop', params: {} });
  if (p.audioTranscode) parts.push({ key: 'qoe.pipeline.audio_transcode', params: {} });
  return parts;
}

/** The server load snapshot of a stall as a translation key and its numbers; the load average is absent on Windows. */
export function loadLine(l: QoeServerLoad, n: Fmt['n'] = plain): PipelinePart {
  const base = { transcodes: String(l.activeTranscodes), sessions: String(l.activeSessions), cpus: String(l.cpuCount) };
  return l.loadAvg1 == null
    ? { key: 'qoe.pipeline.load_no_avg', params: base }
    : { key: 'qoe.pipeline.load', params: { ...base, load: n(l.loadAvg1, 1) } };
}

/** A stall hint key with the evidence it interpolates. */
export function hintParams(e: Pick<QoeEventRow, 'data'>): Record<string, string> {
  return { count: String(e.data?.causeEvidence?.['activeTranscodes'] ?? '') };
}
