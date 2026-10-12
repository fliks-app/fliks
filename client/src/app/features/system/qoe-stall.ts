import type { QoeEventRow, QoePipeline, QoeServerLoad, QoeStallCause } from '../../core/services/api/qoe-api.service';

export const QOE_CAUSES: readonly QoeStallCause[] = ['server', 'network', 'device', 'unknown'];

export const QOE_CAUSE_DOT_CLASS: Record<QoeStallCause, string> = {
  server: 'bg-error',
  network: 'bg-warning',
  device: 'bg-info',
  unknown: 'bg-base-content/30',
};

const mbps = (bps: number | undefined) => (bps == null ? '-' : (bps / 1_000_000).toFixed(1));

/** The translated line of a stall: the reason key and the evidence numbers it interpolates. */
export function stallExplanation(e: Pick<QoeEventRow, 'data'>): { key: string; params: Record<string, string> } | null {
  const d = e.data;
  if (!d?.cause || !d.causeReason) return null;
  const ev = d.causeEvidence ?? {};
  return {
    key: d.causeReason,
    params: {
      buffer: ev['bufferAheadS'] == null ? '-' : ev['bufferAheadS'].toFixed(1),
      throughput: mbps(ev['bandwidthBps']),
      bitrate: mbps(ev['variantBitrate']),
      wait: ev['waitedMs'] == null ? '-' : (ev['waitedMs'] / 1000).toFixed(1),
      speed: ev['transcodeSpeed'] == null ? '-' : ev['transcodeSpeed'].toFixed(1),
      dropped: ev['droppedPct'] == null ? '-' : ev['droppedPct'].toFixed(0),
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

const CODEC_LABEL: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  mpeg2video: 'MPEG-2',
  vc1: 'VC-1',
  vp9: 'VP9',
};

const codecLabel = (c: string | null | undefined) => (c ? (CODEC_LABEL[c.toLowerCase()] ?? c.toUpperCase()) : '');

function resolutionLabel(height: number | null): string {
  if (height == null) return '';
  return height >= 2000 ? '4K' : `${height}p`;
}

const mbps1 = (bps: number) => `${(bps / 1_000_000).toFixed(bps >= 10_000_000 ? 0 : 1)} Mb/s`;

const join = (xs: (string | null | undefined | false)[]) => xs.filter((x): x is string => !!x).join(' ');

/** "4K HEVC HDR10 → 1080p H.264 8 Mb/s", or just the source when the stream is not re-encoded. */
export function pipelineChain(p: QoePipeline): string {
  const s = p.source;
  const src = s ? join([resolutionLabel(s.height), codecLabel(s.codec), s.hdr]) : '';
  const o = p.output;
  const quality = o?.quality && o.quality !== 'original' && o.quality !== 'remux' ? o.quality.replace(/-hdr$/, '') : '';
  const out = o ? join([quality, codecLabel(o.codec), o.hdr, o.bitrate ? mbps1(o.bitrate) : '']) : '';
  return src && out ? `${src} → ${out}` : src || out;
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

/** The server load snapshot of a stall as a translation key and its numbers. */
export function loadLine(l: QoeServerLoad): PipelinePart {
  return {
    key: 'qoe.pipeline.load',
    params: {
      transcodes: String(l.activeTranscodes),
      sessions: String(l.activeSessions),
      load: l.loadAvg1.toFixed(1),
      cpus: String(l.cpuCount),
    },
  };
}

/** A stall hint key with the evidence it interpolates. */
export function hintParams(e: Pick<QoeEventRow, 'data'>): Record<string, string> {
  return { count: String(e.data?.causeEvidence?.['activeTranscodes'] ?? '') };
}
