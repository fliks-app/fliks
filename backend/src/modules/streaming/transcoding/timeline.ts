/**
 * HLS presentation-timeline normalisation for fMP4 segments.
 *
 * FFmpeg's HLS muxer restarts the fragment decode timeline at 0 on every
 * transcode run: a segment produced by a run that started mid-file carries
 * `tfdt.baseMediaDecodeTime` relative to that run's start, not the segment's
 * true content time. That breaks the HLS requirement that all renditions of a
 * presentation share one coherent, monotonic timeline (RFC 8216 §6.2; Apple
 * HLS Authoring Spec) — the player anchors video and a `SUBTITLES` rendition
 * to different origins, so subtitles drift by the resume offset, and two runs
 * writing the same segment index collide on a backward jump.
 *
 * The packaging layer (the in-memory rewrite already applied to every served
 * segment — see {@link cmafRewrite}) owns the canonical timeline instead of
 * the encoder. Segments sit on a uniform `segmentDuration` grid (forced IDR
 * every `segmentDuration`s, `start_number = secondsToSegmentIndex`), so
 * `seg-N`'s video fragment decodes at exactly `N · segmentDuration`. We use
 * that to recover the run's content start `S` (the run's first segment index ×
 * `segmentDuration`), then SHIFT every track's `tfdt` by `S` — preserving each
 * track's intra-run timing and A/V relationship rather than snapping audio to
 * the video grid (audio fragments are ~whole-AAC-frame, slightly off the video
 * grid; snapping would desync).
 *
 * Result: one absolute, monotonic timeline shared by every rendition, and
 * idempotent segments — `seg-N` carries the same `tfdt` no matter which run
 * produced it, so the cross-run collision cannot occur.
 *
 * The rewrite is in-place over a Buffer copy and never changes box sizes (the
 * `tfdt` value is written in its existing 32- or 64-bit width).
 */

interface Box {
  type: string;
  start: number;
  size: number;
  payloadStart: number;
}

interface TrackInfo {
  timescale: number;
  isVideo: boolean;
}

/** Iterate the boxes in `buf[start, end)`. */
function* boxes(buf: Buffer, start: number, end: number): Generator<Box> {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let payloadStart = off + 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(off + 8));
      payloadStart = off + 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < 8 || off + size > end) break;
    yield { type, start: off, size, payloadStart };
    off += size;
  }
}

function findBox(
  buf: Buffer,
  start: number,
  end: number,
  type: string,
): Box | null {
  for (const b of boxes(buf, start, end)) if (b.type === type) return b;
  return null;
}

/**
 * Parse `trackId → { timescale, isVideo }` from an init segment's `moov`.
 * Empty when the buffer isn't a parseable init (the caller then leaves the
 * segment untouched).
 */
export function parseInitTracks(initBuf: Buffer): Map<number, TrackInfo> {
  const out = new Map<number, TrackInfo>();
  const moov = findBox(initBuf, 0, initBuf.length, 'moov');
  if (!moov) return out;
  for (const trak of boxes(initBuf, moov.payloadStart, moov.start + moov.size)) {
    if (trak.type !== 'trak') continue;
    const trakEnd = trak.start + trak.size;
    const tkhd = findBox(initBuf, trak.payloadStart, trakEnd, 'tkhd');
    const mdia = findBox(initBuf, trak.payloadStart, trakEnd, 'mdia');
    if (!tkhd || !mdia) continue;
    const mdiaEnd = mdia.start + mdia.size;
    // tkhd: fullbox, then (v0) creation(4) modification(4) track_ID(4) …
    //                       (v1) creation(8) modification(8) track_ID(4) …
    const tkVer = initBuf[tkhd.payloadStart];
    const trackId = initBuf.readUInt32BE(
      tkhd.payloadStart + (tkVer === 1 ? 20 : 12),
    );
    const mdhd = findBox(initBuf, mdia.payloadStart, mdiaEnd, 'mdhd');
    if (!mdhd) continue;
    // mdhd: fullbox, then (v0) creation(4) modification(4) timescale(4) …
    //                     (v1) creation(8) modification(8) timescale(4) …
    const mdVer = initBuf[mdhd.payloadStart];
    const timescale = initBuf.readUInt32BE(
      mdhd.payloadStart + (mdVer === 1 ? 20 : 12),
    );
    if (timescale <= 0) continue;
    // hdlr: fullbox(4) pre_defined(4) handler_type(4 = 'vide' | 'soun' | …)
    const hdlr = findBox(initBuf, mdia.payloadStart, mdiaEnd, 'hdlr');
    const handler = hdlr
      ? initBuf.toString('latin1', hdlr.payloadStart + 8, hdlr.payloadStart + 12)
      : '';
    out.set(trackId, { timescale, isVideo: handler === 'vide' });
  }
  return out;
}

interface FragTfdt {
  trackId: number;
  valueOffset: number;
  version: number;
  original: number;
}

/** Collect every fragment's tfdt (trackId via tfhd, value + offset). */
function collectTfdts(buf: Buffer): FragTfdt[] {
  const out: FragTfdt[] = [];
  for (const moof of boxes(buf, 0, buf.length)) {
    if (moof.type !== 'moof') continue;
    for (const traf of boxes(buf, moof.payloadStart, moof.start + moof.size)) {
      if (traf.type !== 'traf') continue;
      const trafEnd = traf.start + traf.size;
      const tfhd = findBox(buf, traf.payloadStart, trafEnd, 'tfhd');
      const tfdt = findBox(buf, traf.payloadStart, trafEnd, 'tfdt');
      if (!tfhd || !tfdt) continue;
      const trackId = buf.readUInt32BE(tfhd.payloadStart + 4); // fullbox(4) track_ID(4)
      const version = buf[tfdt.payloadStart];
      const valueOffset = tfdt.payloadStart + 4;
      const original =
        version === 1
          ? Number(buf.readBigUInt64BE(valueOffset))
          : buf.readUInt32BE(valueOffset);
      out.push({ trackId, valueOffset, version, original });
    }
  }
  return out;
}

/**
 * Shift every fragment's `tfdt` so the segment sits at its true content time
 * on the shared absolute timeline. Returns a new Buffer; box sizes unchanged.
 *
 * The shift `S` (run content-start) is recovered from the video fragment,
 * which decodes exactly on the grid: `S = segIndex·segDuration − videoTfdt/ts`.
 * Every track is then shifted by `S` (scaled to its timescale), preserving
 * the audio fragment's true position relative to video. Audio-only segments
 * (no video fragment, e.g. var_stream_map renditions) fall back to snapping
 * the run start to the nearest grid point — exact for runs shorter than
 * ~`segDuration / 0.008`s, which covers the early/main session pattern.
 */
export function rewriteSegmentTfdt(
  segBuf: Buffer,
  tracks: Map<number, TrackInfo>,
  segIndex: number,
  segDuration: number,
): Buffer {
  if (tracks.size === 0) return segBuf;
  const frags = collectTfdts(segBuf);
  if (frags.length === 0) return segBuf;

  const segStart = segIndex * segDuration;
  const video = frags.find((f) => tracks.get(f.trackId)?.isVideo);
  let runStart: number;
  if (video) {
    const ts = tracks.get(video.trackId)!.timescale;
    runStart = segStart - video.original / ts;
  } else {
    const ref = frags[0];
    const ts = tracks.get(ref.trackId)?.timescale;
    if (!ts) return segBuf;
    runStart =
      Math.round((segStart - ref.original / ts) / segDuration) * segDuration;
  }
  if (runStart <= 0) return segBuf; // already absolute (run started at 0)

  const buf = Buffer.from(segBuf);
  for (const f of frags) {
    const ts = tracks.get(f.trackId)?.timescale;
    if (!ts) continue;
    const value = f.original + Math.round(runStart * ts);
    if (f.version === 1) {
      buf.writeBigUInt64BE(BigInt(value), f.valueOffset);
    } else if (value <= 0xffffffff) {
      buf.writeUInt32BE(value, f.valueOffset);
    }
  }
  return buf;
}
