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
});
