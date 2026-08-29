import { parseInitTracks, rewriteSegmentTfdt } from './timeline';

// Minimal ISO-BMFF box builders — just enough structure for parseInitTracks /
// collectTfdts to walk (moov>trak>[tkhd, mdia>[mdhd, hdlr]] and moof>traf>[tfhd,
// tfdt]). Offsets match what timeline.ts reads.
const TS = 1000; // timescale (ticks/sec)

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

function buildInit(trackId = 1, timescale = TS, handler = 'vide'): Buffer {
  // tkhd v0: version+flags(4) creation(4) modification(4) track_ID(4) → id @12
  const tkhd = box('tkhd', Buffer.concat([Buffer.alloc(12), u32(trackId)]));
  // mdhd v0: version+flags(4) creation(4) modification(4) timescale(4) → ts @12
  const mdhd = box('mdhd', Buffer.concat([Buffer.alloc(12), u32(timescale)]));
  // hdlr: fullbox(4) pre_defined(4) handler_type(4) → handler @8
  const hdlr = box(
    'hdlr',
    Buffer.concat([Buffer.alloc(8), Buffer.from(handler, 'latin1')]),
  );
  const mdia = box('mdia', Buffer.concat([mdhd, hdlr]));
  const trak = box('trak', Buffer.concat([tkhd, mdia]));
  return box('moov', trak);
}

function buildSeg(tfdtValue: number, trackId = 1): Buffer {
  // tfhd: fullbox(4) track_ID(4) → id @4
  const tfhd = box('tfhd', Buffer.concat([Buffer.alloc(4), u32(trackId)]));
  // tfdt v0: version(1)+flags(3) baseMediaDecodeTime(4) → value @4
  const tfdt = box('tfdt', Buffer.concat([Buffer.from([0, 0, 0, 0]), u32(tfdtValue)]));
  const traf = box('traf', Buffer.concat([tfhd, tfdt]));
  return Buffer.concat([box('moof', traf), box('mdat', Buffer.alloc(4))]);
}

function readTfdt(buf: Buffer): number {
  // box: size(4) type(4) version+flags(4) value(4) → value 8 bytes after 'tfdt'
  const i = buf.indexOf(Buffer.from('tfdt', 'latin1'));
  return buf.readUInt32BE(i + 8);
}

describe('rewriteSegmentTfdt', () => {
  const tracks = parseInitTracks(buildInit());
  const SEG = 4;

  it('parses the synthetic init (sanity)', () => {
    expect(tracks.size).toBe(1);
    expect(tracks.get(1)).toEqual({ timescale: TS, isVideo: true });
  });

  it('is a no-op when the segment is already grid-aligned (transcode)', () => {
    // seg-25's tfdt already at 25*4=100s → runStart 0 → left untouched.
    const out = rewriteSegmentTfdt(buildSeg(100 * TS), tracks, 25, SEG);
    expect(readTfdt(out)).toBe(100 * TS);
  });

  it('shifts a run-relative tfdt onto its absolute grid position', () => {
    // A mid-file transcode run reset tfdt to 0 for seg-25 → anchored to 100s.
    const out = rewriteSegmentTfdt(buildSeg(0), tracks, 25, SEG);
    expect(readTfdt(out)).toBe(100 * TS);
  });

  it('snaps a sub-grid tfdt onto the grid — why remux must skip the anchor (#349)', () => {
    // A remux seg-25 (GOP-aligned -c:v copy + -copyts) carries its true source
    // IDR PTS (98s), NOT the 100s grid. The anchor wrongly shifts it +2s onto
    // the grid; because each remux segment's IDR offset differs, the timeline
    // becomes non-monotonic — so serveCmafFile skips the anchor for remux.
    const out = rewriteSegmentTfdt(buildSeg(98 * TS), tracks, 25, SEG);
    expect(readTfdt(out)).toBe(100 * TS); // 98s corrupted to 100s — the bug
  });

  /**
   * A source whose video starts at a non-zero PTS (TS captures, PVR rips). The
   * run spawned at 0 keeps that origin — ffmpeg's `-copyts` passes absolute PTS
   * through — so a run spawned mid-file has to be anchored onto it as well, or
   * the two disagree by exactly `start_time`. The WebVTT `X-TIMESTAMP-MAP` adds
   * `start_time` unconditionally, so it can only ever be right for one of them:
   * subtitles ran `start_time` late on every seeked or resumed session.
   */
  describe('a source with a non-zero start_time', () => {
    const START = 2.8;

    it('leaves a run started at 0 exactly where ffmpeg put it', () => {
      // seg-25 of an absolute run decodes at 100 + 2.8 = its own tfdt already.
      const out = rewriteSegmentTfdt(
        buildSeg((100 + START) * TS),
        tracks,
        25,
        SEG,
        START,
      );
      expect(readTfdt(out)).toBe((100 + START) * TS);
    });

    it('anchors a mid-file run onto the same origin, not onto bare content time', () => {
      const out = rewriteSegmentTfdt(buildSeg(0), tracks, 25, SEG, START);
      expect(readTfdt(out)).toBe((100 + START) * TS);
    });

    it('puts both runs on one timeline — the whole point', () => {
      const fromZero = rewriteSegmentTfdt(
        buildSeg((100 + START) * TS),
        tracks,
        25,
        SEG,
        START,
      );
      const seeked = rewriteSegmentTfdt(buildSeg(0), tracks, 25, SEG, START);
      expect(readTfdt(seeked)).toBe(readTfdt(fromZero));
    });

    // The absolute run lands within a frame of the grid, never exactly on it.
    // `runStart <= 0` used to catch that; an epsilon has to, or a segment
    // nothing asked to move gets nudged by the rounding.
    it('does not nudge an absolute run that is a frame off the grid', () => {
      const off = Math.round((100 + START) * TS) + 0.04 * TS;
      const out = rewriteSegmentTfdt(buildSeg(off), tracks, 25, SEG, START);
      expect(readTfdt(out)).toBe(off);
    });
  });
});
