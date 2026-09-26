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

export interface TrackInfo {
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
  /** Read signed: ffmpeg writes a decode time before 0 as a negative int64. */
  original: bigint;
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
          ? buf.readBigInt64BE(valueOffset)
          : BigInt(buf.readUInt32BE(valueOffset));
      out.push({ trackId, valueOffset, version, original });
    }
  }
  return out;
}

/** Source time the served fMP4 timeline puts at content 0. A video starting
 *  before 0 (a wrapped MPEG-TS clock, negative Matroska times) is served from 0,
 *  since a tfdt can't go below 0: see `servedShift`. */
export function timelineOrigin(startPts = 0): number {
  return Math.max(0, startPts);
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
  startPts = 0,
): Buffer {
  if (tracks.size === 0) return segBuf;
  const frags = collectTfdts(segBuf);
  if (frags.length === 0) return segBuf;

  // Every run's output starts at 0 (see `originSeconds` in ffmpeg-args), so the
  // source start_time is part of the shift; the WebVTT X-TIMESTAMP-MAP adds it
  // too.
  const segStart = segIndex * segDuration + startPts;
  const video = frags.find((f) => tracks.get(f.trackId)?.isVideo);
  const ref = video ?? frags[0];
  const refTs = tracks.get(ref.trackId)?.timescale;
  if (!refTs) return segBuf;
  const refTime = Number(ref.original) / refTs;

  let runStart = segStart - refTime;
  if (!video) {
    // Audio-only rendition (var_stream_map): no video fragment to anchor on, so
    // the run offset is snapped to the grid to shed sub-frame jitter. Only the
    // *content* part is a grid multiple — start_time is not — so it is removed
    // before snapping and restored after. Rounding it away here would shift an
    // audio rendition off the video it belongs to by exactly start_time, which
    // is the whole class of A/V desync #756/#771/#791 exist to prevent.
    runStart =
      Math.round((runStart - startPts) / segDuration) * segDuration + startPts;
  }
  return moveTfdts(Buffer.from(segBuf), frags, (id) => {
    const ts = tracks.get(id)?.timescale;
    return ts ? BigInt(Math.round(runStart * ts)) : undefined;
  });
}

/** Move each fragment's tfdt in place by its track's ticks; a fragment whose
 *  track `ticksOf` leaves undefined stays. */
function moveTfdts(
  buf: Buffer,
  frags: FragTfdt[],
  ticksOf: (trackId: number) => bigint | undefined,
): Buffer {
  for (const f of frags) {
    const ticks = ticksOf(f.trackId);
    if (ticks !== undefined) writeTfdt(buf, f, f.original + ticks);
  }
  return buf;
}

function writeTfdt(buf: Buffer, f: FragTfdt, value: bigint): void {
  // A decode time can't go below 0; writing one would wrap to ~5.8e14 s.
  if (value < 0n) {
    throw new RangeError(
      `tfdt ${value} of track ${f.trackId} would be negative at offset ${f.valueOffset}`,
    );
  }
  if (f.version === 1) {
    buf.writeBigUInt64BE(value, f.valueOffset);
  } else if (value <= 0xffffffffn) {
    buf.writeUInt32BE(Number(value), f.valueOffset);
  } else {
    // Widening a version-0 tfdt would change the box size.
    throw new RangeError(
      `tfdt ${value} exceeds the 32-bit version-0 box at offset ${f.valueOffset}`,
    );
  }
}

/** Media time each track's presentation starts at, in its timescale ticks:
 *  its edit's `media_time` less the empty edits ahead of it, 0 without an edit. */
export function readInitEdits(initBuf: Buffer): Map<number, bigint> {
  const out = new Map<number, bigint>();
  const moov = findBox(initBuf, 0, initBuf.length, 'moov');
  if (!moov) return out;
  const moovEnd = moov.start + moov.size;
  const mvhd = findBox(initBuf, moov.payloadStart, moovEnd, 'mvhd');
  const movieTs = mvhd
    ? initBuf.readUInt32BE(mvhd.payloadStart + (initBuf[mvhd.payloadStart] === 1 ? 20 : 12))
    : 0;
  for (const [trackId, info] of parseInitTracks(initBuf)) {
    const trak = trakOf(initBuf, moov, trackId);
    const edts = trak && findBox(initBuf, trak.payloadStart, trak.start + trak.size, 'edts');
    const elst =
      edts && findBox(initBuf, edts.payloadStart, edts.start + edts.size, 'elst');
    let ticks = 0n;
    if (elst) {
      const v1 = initBuf[elst.payloadStart] === 1;
      const count = initBuf.readUInt32BE(elst.payloadStart + 4);
      let off = elst.payloadStart + 8;
      for (let i = 0; i < count; i++, off += v1 ? 20 : 12) {
        const duration = v1 ? initBuf.readBigUInt64BE(off) : BigInt(initBuf.readUInt32BE(off));
        const mediaTime = v1 ? initBuf.readBigInt64BE(off + 8) : BigInt(initBuf.readInt32BE(off + 4));
        if (mediaTime !== -1n) {
          ticks += mediaTime;
          break;
        }
        if (!movieTs) throw new Error(`track ${trackId} has an empty edit and no movie timescale`);
        ticks -= (duration * BigInt(info.timescale)) / BigInt(movieTs);
      }
    }
    out.set(trackId, ticks);
  }
  return out;
}

function trakOf(buf: Buffer, moov: Box, trackId: number): Box | null {
  for (const trak of boxes(buf, moov.payloadStart, moov.start + moov.size)) {
    if (trak.type !== 'trak') continue;
    const tkhd = findBox(buf, trak.payloadStart, trak.start + trak.size, 'tkhd');
    if (tkhd && buf.readUInt32BE(tkhd.payloadStart + (buf[tkhd.payloadStart] === 1 ? 20 : 12)) === trackId) {
      return trak;
    }
  }
  return null;
}

/** 32-bit box: `type` around the concatenated `children`. */
function makeBox(type: string, children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** One edit starting the presentation `ticks` into the media, for the whole of
 *  a fragmented track (duration 0). */
function singleEdit(ticks: bigint): Buffer {
  const v1 = ticks > 0x7fffffffn;
  const entry = Buffer.alloc(v1 ? 20 : 12);
  if (v1) entry.writeBigInt64BE(ticks, 8);
  else entry.writeInt32BE(Number(ticks), 4);
  entry.writeUInt32BE(0x00010000, v1 ? 16 : 8);
  const head = Buffer.from([v1 ? 1 : 0, 0, 0, 0, 0, 0, 0, 1]);
  return makeBox('edts', [makeBox('elst', [head, entry])]);
}

/** `initBuf` with each track's edits replaced by one starting its presentation
 *  `secondsOf(track)` into its media. */
export function withInitEdits(
  initBuf: Buffer,
  secondsOf: (track: TrackInfo) => number,
): Buffer {
  const tracks = parseInitTracks(initBuf);
  const rebuildTrak = (trak: Box): Buffer => {
    const trakEnd = trak.start + trak.size;
    const tkhd = findBox(initBuf, trak.payloadStart, trakEnd, 'tkhd');
    const id = tkhd
      ? initBuf.readUInt32BE(tkhd.payloadStart + (initBuf[tkhd.payloadStart] === 1 ? 20 : 12))
      : -1;
    const info = tracks.get(id);
    if (!info) return initBuf.subarray(trak.start, trakEnd);
    const edit = singleEdit(BigInt(Math.round(secondsOf(info) * info.timescale)));
    const children: Buffer[] = [];
    for (const b of boxes(initBuf, trak.payloadStart, trakEnd)) {
      if (b.type === 'edts') continue;
      children.push(initBuf.subarray(b.start, b.start + b.size));
      if (b.type === 'tkhd') children.push(edit);
    }
    return makeBox('trak', children);
  };
  const out: Buffer[] = [];
  for (const top of boxes(initBuf, 0, initBuf.length)) {
    if (top.type !== 'moov') {
      out.push(initBuf.subarray(top.start, top.start + top.size));
      continue;
    }
    const children: Buffer[] = [];
    for (const b of boxes(initBuf, top.payloadStart, top.start + top.size)) {
      children.push(b.type === 'trak' ? rebuildTrak(b) : initBuf.subarray(b.start, b.start + b.size));
    }
    out.push(makeBox('moov', children));
  }
  return Buffer.concat(out);
}

/** Move every fragment's `tfdt` by its track's tick count, in place. */
export function retimeFragments(
  segBuf: Buffer,
  deltaTicks: Map<number, bigint>,
): Buffer {
  return moveTfdts(segBuf, collectTfdts(segBuf), (id) => {
    const delta = deltaTicks.get(id);
    if (delta === undefined) {
      throw new Error(`fragment of track ${id}, absent from the init`);
    }
    return delta;
  });
}

/** Decode time of the first fragment of `trackId`, in its timescale ticks. */
export function firstTfdt(segBuf: Buffer, trackId: number): bigint | null {
  return collectTfdts(segBuf).find((f) => f.trackId === trackId)?.original ?? null;
}
