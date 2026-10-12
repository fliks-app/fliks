import type { DesktopQoe } from '../../shared/contract';

type Raw = string | number | null | undefined;

const toNum = (v: Raw): number | null => {
  const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const toStr = (v: Raw): string | null => (v == null || v === '' ? null : String(v));

/** Cumulative sum of a raw mpv counter: the first value is a baseline, a drop is a reset. */
class Counter {
  total = 0;
  private last: number | null;

  /** `from`: a baseline known up front (0 counts the first reading, capped). */
  constructor(from: number | null = null) {
    this.last = from;
  }

  /** `cap` bounds a position-derived delta (a seek is not decoding); then a drop is a backward
   *  seek and adds nothing, otherwise it is a counter reset and the new value counts. */
  add(raw: number | null, cap = Infinity): void {
    if (raw == null) return;
    if (this.last != null) {
      const delta = raw >= this.last ? raw - this.last : cap === Infinity ? raw : 0;
      this.total += Math.min(delta, cap);
    }
    this.last = raw;
  }
}

/** Turns mpv's seek-sensitive properties into counters cumulative since the last reset(). */
export class QoeReader {
  private dropVo = new Counter();
  private dropDec = new Counter();
  private decoded = new Counter(0);
  private lastAt: number;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.lastAt = now();
  }

  reset(): void {
    this.dropVo = new Counter();
    this.dropDec = new Counter();
    this.decoded = new Counter(0);
    this.lastAt = this.now();
  }

  /** Null when mpv reports nothing at all (not started or gone). */
  async read(get: (name: string) => Promise<Raw> | Raw): Promise<DesktopQoe | null> {
    const raw = async (name: string): Promise<Raw> => {
      try {
        return await get(name);
      } catch {
        return null;
      }
    };
    const [vo, dec, est, cfps, vfps, hwdec, fmt, speed, ahead, hls, bitrate, w, h] =
      await Promise.all([
        raw('frame-drop-count'),
        raw('decoder-frame-drop-count'),
        raw('estimated-frame-number'),
        raw('container-fps'),
        raw('estimated-vf-fps'),
        raw('hwdec-current'),
        raw('video-format'),
        raw('cache-speed'),
        raw('demuxer-cache-duration'),
        raw('current-tracks/video/hls-bitrate'),
        raw('video-bitrate'),
        raw('video-params/w'),
        raw('video-params/h'),
      ]);
    const t = this.now();
    const elapsedS = (t - this.lastAt) / 1000;
    this.lastAt = t;
    const voN = toNum(vo);
    const decN = toNum(dec);
    const estN = toNum(est);
    const cfpsN = toNum(cfps);
    const maxFps = cfpsN ? cfpsN * 1.1 : (toNum(vfps) || 60) * 1.5;
    this.dropVo.add(voN);
    this.dropDec.add(decN);
    this.decoded.add(estN, elapsedS * maxFps);
    const hw = toStr(hwdec);
    const speedBytes = toNum(speed);
    const out: DesktopQoe = {
      droppedFrames: voN == null && decN == null ? null : this.dropVo.total + this.dropDec.total,
      decodedFrames: estN == null ? null : this.decoded.total,
      bandwidthBps: speedBytes ? speedBytes * 8 : null,
      bufferAheadS: toNum(ahead),
      variantBitrate: toNum(hls) || toNum(bitrate),
      width: toNum(w),
      height: toNum(h),
      videoCodec: toStr(fmt),
      decoderName: hw && hw !== 'no' ? hw : toStr(fmt),
      hwDecoder: hw == null ? null : hw !== 'no',
    };
    return Object.values(out).every((v) => v == null) ? null : out;
  }
}
