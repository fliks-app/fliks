import type { DesktopQoe } from '../../shared/contract';

type Raw = string | number | null | undefined;

const toNum = (v: Raw): number | null => {
  const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const toStr = (v: Raw): string | null => (v == null || v === '' ? null : String(v));

/** Reads mpv properties through `get` (any backend); a property mpv can't give yields null. */
export async function readQoe(get: (name: string) => Promise<Raw> | Raw): Promise<DesktopQoe> {
  const raw = async (name: string): Promise<Raw> => {
    try {
      return await get(name);
    } catch {
      return null;
    }
  };
  const [vo, dec, est, hwdec, codec, fmt, speed, ahead, bitrate, w, h] = await Promise.all([
    raw('frame-drop-count'),
    raw('decoder-frame-drop-count'),
    raw('estimated-frame-number'),
    raw('hwdec-current'),
    raw('video-codec'),
    raw('video-format'),
    raw('cache-speed'),
    raw('demuxer-cache-duration'),
    raw('video-bitrate'),
    raw('video-params/w'),
    raw('video-params/h'),
  ]);
  const drops = [toNum(vo), toNum(dec)];
  const hw = toStr(hwdec);
  const speedBytes = toNum(speed);
  return {
    droppedFrames: drops.every((d) => d == null) ? null : drops.reduce<number>((a, d) => a + (d ?? 0), 0),
    decodedFrames: toNum(est),
    bandwidthBps: speedBytes == null ? null : speedBytes * 8,
    bufferAheadS: toNum(ahead),
    variantBitrate: toNum(bitrate),
    width: toNum(w),
    height: toNum(h),
    videoCodec: toStr(fmt),
    decoderName: hw && hw !== 'no' ? hw : toStr(codec),
    hwDecoder: hw == null ? null : hw !== 'no',
  };
}
