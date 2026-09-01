/**
 * Single-I-frame segments for HLS trick play.
 *
 * AVPlay only accelerates HLS when the master advertises an
 * `EXT-X-I-FRAME-STREAM-INF` rendition, and RFC 8216 4.3.3.6 wants one I-frame
 * per media segment. The transcode ladder can't back that with byte ranges (its
 * segments are produced on demand, so their offsets aren't known when the
 * playlist is written), so the rendition gets its own segments: one keyframe,
 * decoded straight from the source at the grid position the player asks for.
 */

/** Trick-play frames are decoration, not playback: 720p keeps the per-frame
 *  encode cheap enough to answer a 16x scan. */
const MAX_HEIGHT = 720;

/** H.264 Main@3.1, what {@link buildIFrameSegmentArgs} emits at 720p. */
export const IFRAME_CODEC = 'avc1.4d401f';

/** One 720p keyframe every `segmentSeconds`, rounded up from ~120 kB. */
export function iframeBandwidthBps(segmentSeconds: number): number {
  return Math.round((120_000 * 8) / Math.max(1, segmentSeconds));
}

/** Output size for the trick-play rendition: source aspect, capped at
 *  {@link MAX_HEIGHT}, both axes even (yuv420p). */
export function iframeResolution(
  sourceWidth: number,
  sourceHeight: number,
): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (sourceHeight <= MAX_HEIGHT) {
    return { width: even(sourceWidth), height: even(sourceHeight) };
  }
  return {
    width: even((sourceWidth * MAX_HEIGHT) / sourceHeight),
    height: MAX_HEIGHT,
  };
}

/** ffmpeg argv for one keyframe at `seekSeconds`, muxed to MPEG-TS on stdout.
 *  `-ss` before `-i` is the demuxer keyframe seek (the grid is IDR-aligned, so
 *  it lands on the frame the playlist promised) and `-copyts` keeps the source
 *  PTS, so the frame carries its real presentation time. */
export function buildIFrameSegmentArgs(opts: {
  inputPath: string;
  seekSeconds: number;
  width: number;
  height: number;
  crop?: { width: number; height: number; x: number; y: number };
}): string[] {
  const crop = opts.crop
    ? `crop=${opts.crop.width}:${opts.crop.height}:${opts.crop.x}:${opts.crop.y},`
    : '';
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    opts.seekSeconds.toFixed(3),
    '-copyts',
    '-i',
    opts.inputPath,
    '-frames:v',
    '1',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `${crop}scale=${opts.width}:${opts.height}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'mpegts',
    '-muxdelay',
    '0',
    '-muxpreload',
    '0',
    'pipe:1',
  ];
}
