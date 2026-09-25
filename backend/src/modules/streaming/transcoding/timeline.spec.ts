import {
  parseInitTracks,
  rewriteSegmentTfdt,
  shiftSegmentTfdt,
  timelineOrigin,
} from './timeline';

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

function buildTrak(trackId: number, timescale: number, handler: string): Buffer {
  const tkhd = box('tkhd', Buffer.concat([Buffer.alloc(12), u32(trackId)]));
  const mdhd = box('mdhd', Buffer.concat([Buffer.alloc(12), u32(timescale)]));
  const hdlr = box(
    'hdlr',
    Buffer.concat([Buffer.alloc(8), Buffer.from(handler, 'latin1')]),
  );
  return box('trak', Buffer.concat([tkhd, box('mdia', Buffer.concat([mdhd, hdlr]))]));
}

/** One moov carrying both a video and an audio trak — the inline (non
 *  var_stream_map) shape, where one segment holds fragments for both. */
function buildInitAv(): Buffer {
  return box(
    'moov',
    Buffer.concat([buildTrak(1, TS, 'vide'), buildTrak(2, TS, 'soun')]),
  );
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
   * A source whose video starts at a non-zero PTS (TS captures, PVR rips).
   * Every run's output starts at 0, so both the run from the file start and a
   * mid-file run are moved onto the `start_time` origin, the one the WebVTT
   * `X-TIMESTAMP-MAP` adds.
   */
  describe('a source with a non-zero start_time', () => {
    const START = 2.8;

    it('moves a run started at 0 onto the origin', () => {
      const out = rewriteSegmentTfdt(buildSeg(100 * TS), tracks, 25, SEG, START);
      expect(readTfdt(out)).toBe((100 + START) * TS);
    });

    it('anchors a mid-file run onto the same origin, not onto bare content time', () => {
      const out = rewriteSegmentTfdt(buildSeg(0), tracks, 25, SEG, START);
      expect(readTfdt(out)).toBe((100 + START) * TS);
    });

    it('puts both runs on one timeline', () => {
      const fromZero = rewriteSegmentTfdt(buildSeg(100 * TS), tracks, 25, SEG, START);
      const seeked = rewriteSegmentTfdt(buildSeg(0), tracks, 25, SEG, START);
      expect(readTfdt(seeked)).toBe(readTfdt(fromZero));
    });

    // Under half a segment the origin is indistinguishable from grid jitter, so
    // any "already absolute" shortcut would leave seg-0 of the first run at 0.
    it('moves a start_time shorter than half a segment too', () => {
      const out = rewriteSegmentTfdt(buildSeg(0), tracks, 0, SEG, 1.4);
      expect(readTfdt(out)).toBe(1.4 * TS);
    });
  });

  /**
   * A/V alignment is the property this whole file exists to protect (#756,
   * #771, #791). Two ways it can break here, both load-bearing:
   *
   * Within one segment every track takes the SAME shift, so their relative
   * offset survives. Across a var_stream_map session video and audio are
   * separate renditions anchored independently, so both branches must agree on
   * the origin — including the start_time part, which is not a grid multiple
   * and which the audio branch's grid snap will silently round away if it is
   * not removed before snapping and restored after.
   */
  describe('audio stays aligned to video', () => {
    const audioOnly = parseInitTracks(buildInit(2, TS, 'soun'));
    const START = 2.8;

    it('shifts every track of a segment by the same amount', () => {
      const both = parseInitTracks(buildInitAv());
      // Audio sits 0.5s after video inside the run; that gap must survive.
      const seg = Buffer.concat([buildSeg(0, 1), buildSeg(0.5 * TS, 2)]);
      const out = rewriteSegmentTfdt(seg, both, 25, SEG, START);

      const tfdts: number[] = [];
      for (let i = out.indexOf(Buffer.from('tfdt', 'latin1')); i !== -1; ) {
        tfdts.push(out.readUInt32BE(i + 8));
        i = out.indexOf(Buffer.from('tfdt', 'latin1'), i + 1);
      }
      expect(tfdts).toEqual([(100 + START) * TS, (100.5 + START) * TS]);
    });

    it('lands an audio rendition on the same origin as its video rendition', () => {
      // The anchor shifts the run, not the fragment: an audio fragment 20ms
      // into its segment stays 20ms in. What must match is the shift applied.
      const v = readTfdt(rewriteSegmentTfdt(buildSeg(0, 1), tracks, 25, SEG, START)) - 0;
      const a =
        readTfdt(rewriteSegmentTfdt(buildSeg(0.02 * TS, 2), audioOnly, 25, SEG, START)) -
        0.02 * TS;
      expect(a).toBe(v);
      expect(a).toBe((100 + START) * TS);
    });

    it('moves an audio rendition of the run from 0 onto the origin', () => {
      // Its first fragment trails the grid by the encoder priming.
      const out = rewriteSegmentTfdt(buildSeg(21, 2), audioOnly, 0, SEG, START);
      expect(readTfdt(out)).toBe(21 + START * TS);
    });

    // With no start_time the snap is a plain grid round and a run at 0 stays.
    it('leaves a start_time 0 run from the file start in place', () => {
      // Run-relative: snapped to a 100s run origin, fragment keeps its 20ms.
      expect(readTfdt(rewriteSegmentTfdt(buildSeg(0.02 * TS, 2), audioOnly, 25, SEG))).toBe(
        100.02 * TS,
      );
      // From the file start: left alone.
      expect(readTfdt(rewriteSegmentTfdt(buildSeg(100 * TS, 2), audioOnly, 25, SEG))).toBe(
        100 * TS,
      );
    });
  });
});

describe('shiftSegmentTfdt', () => {
  const both = parseInitTracks(buildInitAv());

  it('moves every track of a keyframe-cut segment by the origin, off-grid times kept', () => {
    const seg = Buffer.concat([buildSeg(98 * TS, 1), buildSeg(97.979 * TS, 2)]);
    const out = shiftSegmentTfdt(seg, both, 2.8);
    const i = out.indexOf(Buffer.from('tfdt', 'latin1'));
    const j = out.indexOf(Buffer.from('tfdt', 'latin1'), i + 1);
    expect(out.readUInt32BE(i + 8)).toBe(100.8 * TS);
    expect(out.readUInt32BE(j + 8)).toBe(Math.round(100.779 * TS));
  });

  it('returns the same buffer for a zero origin', () => {
    const seg = buildSeg(98 * TS, 1);
    expect(shiftSegmentTfdt(seg, both, 0)).toBe(seg);
  });
});

describe('timelineOrigin', () => {
  it('keeps a positive start and clamps a negative one to 0', () => {
    expect(timelineOrigin(2.8)).toBe(2.8);
    expect(timelineOrigin(-0.042)).toBe(0);
    expect(timelineOrigin(undefined)).toBe(0);
  });
});
