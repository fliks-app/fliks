import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from '@nestjs/common';
import {
  RemuxSegmentAssembler,
  remuxAssemblyPlan,
  remuxEdits,
} from './remux-assembler';
import { computeSegmentGrid } from './segment-boundaries';
import { makeBox, readInitEdits, u32 } from './timeline';

const box = (type: string, payload: Buffer) => makeBox(type, [payload]);

/** A trak with one v0 edit at `mediaTime`. */
function trak(id: number, timescale: number, handler: string, mediaTime: number): Buffer {
  const entry = Buffer.alloc(12);
  entry.writeInt32BE(mediaTime, 4);
  return box(
    'trak',
    Buffer.concat([
      box('tkhd', Buffer.concat([Buffer.alloc(12), u32(id)])),
      box('edts', box('elst', Buffer.concat([Buffer.alloc(4), u32(1), entry]))),
      box(
        'mdia',
        Buffer.concat([
          box('mdhd', Buffer.concat([Buffer.alloc(12), u32(timescale)])),
          box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from(handler, 'latin1')])),
        ]),
      ),
    ]),
  );
}

/** version-0 trun, one sample, explicit duration (flag 0x100). */
const videoTrun = (durationTicks: number) =>
  box('trun', Buffer.concat([Buffer.from([0, 0, 1, 0]), u32(1), u32(durationTicks)]));

// This file's keyframes are always 2s apart at the 1000 timescale fixtures
// use: a video fragment spanning exactly that reaches its next keyframe.
const GOP_DECODE_SPAN_TICKS = 2000;

/** A GOP file: one video (with a trun reaching the next keyframe) and one
 *  audio fragment, v1 tfdt. */
function gop(videoTfdt: bigint, audioTfdt: bigint, videoDurationTicks = GOP_DECODE_SPAN_TICKS): Buffer {
  const traf = (id: number, v: bigint, trun: Buffer | null) => {
    const t = Buffer.alloc(8);
    t.writeBigInt64BE(v);
    return box(
      'traf',
      Buffer.concat([
        box('tfhd', Buffer.concat([Buffer.alloc(4), u32(id)])),
        box('tfdt', Buffer.concat([Buffer.from([1, 0, 0, 0]), t])),
        ...(trun ? [trun] : []),
      ]),
    );
  };
  return Buffer.concat([
    box('moof', traf(1, videoTfdt, videoTrun(videoDurationTicks))),
    box('mdat', Buffer.alloc(2)),
    box('moof', traf(2, audioTfdt, null)),
  ]);
}

const tfdts = (buf: Buffer): number[] => {
  const out: number[] = [];
  for (let i = buf.indexOf('tfdt'); i !== -1; i = buf.indexOf('tfdt', i + 1)) {
    out.push(Number(buf.readBigUInt64BE(i + 8)));
  }
  return out;
};

const log = { log() {}, warn: jest.fn(), error: jest.fn() } as unknown as Logger;

// Keyframes every 2 s from 0, 2-frame reorder at 25 fps; segments of 4 s.
const grid = computeSegmentGrid(
  [0, 2, 4, 6, 8, 10].map((pts) => ({ pts, dts: pts - 0.08 })),
  0,
  12,
  4,
)!;

describe('RemuxSegmentAssembler', () => {
  let dir: string;
  let gopDir: string;
  const newRun = () => {
    fs.mkdirSync(gopDir);
    // ffmpeg's run init: video starts 2 frames into its media, audio at once.
    fs.writeFileSync(
      path.join(gopDir, 'init.mp4'),
      box('moov', Buffer.concat([trak(1, 1000, 'vide', 80), trak(2, 48000, 'soun', 0)])),
    );
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remux-asm-'));
    gopDir = path.join(dir, 'gop-run');
    newRun();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const assembler = (
    startSegment: number,
    seekSeconds: number | null,
    startNumber: number,
    g: typeof grid | null = grid,
    onFailure?: (err: Error) => void,
  ) =>
    new RemuxSegmentAssembler(
      remuxAssemblyPlan({
        dir,
        gopDir,
        grid: g,
        startSegment,
        run: { audioStartSeconds: 0, seekSeconds, startNumber },
        origin: 0,
      }),
      log,
      'test',
      onFailure,
    );
  const assemble = async (
    startSegment: number,
    seekSeconds: number | null,
    startNumber: number,
    g: typeof grid | null = grid,
    exitedCleanly = true,
  ) => {
    const asm = assembler(startSegment, seekSeconds, startNumber, g);
    asm.start();
    await asm.finish(exitedCleanly);
  };
  const writeGops = (count: number) =>
    [0, 2, 4, 6, 8, 10].slice(0, count).forEach((t, i) =>
      fs.writeFileSync(path.join(gopDir, `gop-${i}.m4s`), gop(BigInt(t * 1000), BigInt(t * 48000))),
    );
  const segs = () => fs.readdirSync(dir).filter((f) => f.startsWith('seg-')).sort();
  const edits = remuxEdits(grid.boundaries[0], grid.keyframes[0].dts);
  // This fixture's own run records no audio priming (media_time 0), so its served edit is 0.
  const audioEdit = 0;

  it('lifts a grid that starts before 0 onto 0', () => {
    const wrapped = computeSegmentGrid(
      [-23.72, -21.72].map((pts) => ({ pts, dts: pts - 0.08 })),
      -23.72,
      -19.72,
      2,
    )!;
    const e = remuxEdits(wrapped.boundaries[0], wrapped.keyframes[0].dts);
    expect(e.shift).toBeCloseTo(23.72, 9);
    expect(e.video).toBeCloseTo(0.08, 9);
  });

  it('derives the video edit from the first keyframe', () => {
    expect(edits.video).toBeCloseTo(0.08, 9);
  });

  it("carries a track's own priming, not the video's reorder delay, into its served edit", async () => {
    // Reorder (0.2 s) is ~10x the real AAC priming (1024 ticks @48k, 0.021 s):
    // a shared headroom sized off the video would leak into the audio's tfdt.
    const bigReorder = computeSegmentGrid(
      [0, 2, 4, 6, 8, 10].map((pts) => ({ pts, dts: pts - 0.2 })),
      0,
      12,
      4,
    )!;
    fs.writeFileSync(
      path.join(gopDir, 'init.mp4'),
      box('moov', Buffer.concat([trak(1, 1000, 'vide', 200), trak(2, 48000, 'soun', 1024)])),
    );
    fs.writeFileSync(path.join(gopDir, 'gop-0.m4s'), gop(0n, 0n));
    await assemble(0, null, 0, bigReorder);
    // Both tracks' first sample decodes at 0: audio isn't pushed out by video's edit.
    expect(tfdts(fs.readFileSync(path.join(dir, 'seg-0000.m4s')))).toEqual([0, 0]);
    const init = readInitEdits(fs.readFileSync(path.join(dir, 'init.mp4')));
    expect(init.get(1)).toBe(200n);
    expect(init.get(2)).toBe(1024n);
  });

  it('joins each segment from its grid GOPs and retimes them onto the served timeline', async () => {
    // A run from the file start: timestamps are source time, tfdt its first pts.
    [0, 2, 4, 6, 8, 10].forEach((t, i) =>
      fs.writeFileSync(
        path.join(gopDir, `gop-${i}.m4s`),
        gop(BigInt(t * 1000), BigInt(Math.round((t - 0.021) * 48000))),
      ),
    );
    await assemble(0, null, 0);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('seg-')).sort()).toEqual([
      'seg-0000.m4s',
      'seg-0001.m4s',
      'seg-0002.m4s',
    ]);
    // Video: the run's edit (80) comes off, the served one (80) back on: its
    // tfdt stays its first frame. Audio: GOP-0's sample (t=-0.021, real
    // priming) is its own first frame, clamped to 0; later ones land on the
    // same round grid as video, not shifted by any extra headroom.
    const seg1 = fs.readFileSync(path.join(dir, 'seg-0001.m4s'));
    expect(tfdts(seg1)).toEqual([4000, 4 * 48000, 6000, 6 * 48000]);
    const init = readInitEdits(fs.readFileSync(path.join(dir, 'init.mp4')));
    expect(init.get(1)).toBe(80n);
    expect(init.get(2)).toBe(BigInt(audioEdit));
    expect(fs.existsSync(gopDir)).toBe(false);
  });

  it('adds back the output -ss as ffmpeg rounded it, whichever run made the segment', async () => {
    // Segment 1 run: -ss 3.9195 rounded to the 1 ms source time base, 3.920.
    [4, 6, 8, 10].forEach((t, k) =>
      fs.writeFileSync(
        path.join(gopDir, `gop-${2 + k}.m4s`),
        gop(BigInt(Math.round((t - 3.92) * 1000)), BigInt(Math.round((t - 3.92) * 48000))),
      ),
    );
    await assemble(1, 3.9195, 2);
    const seg1 = fs.readFileSync(path.join(dir, 'seg-0001.m4s'));
    expect(tfdts(seg1)[0]).toBe(4000);
    expect(tfdts(seg1)[1]).toBe(4 * 48000 + audioEdit);
    expect(fs.existsSync(path.join(dir, 'seg-0000.m4s'))).toBe(false);
  });

  it('follows a run that landed a GOP late and says so', async () => {
    [6, 8, 10].forEach((t, k) =>
      fs.writeFileSync(
        path.join(gopDir, `gop-${2 + k}.m4s`),
        gop(BigInt(Math.round((t - 3.92) * 1000)), BigInt(Math.round((t - 3.92) * 48000))),
      ),
    );
    await assemble(1, 3.9195, 2);
    // GOPs 3.. only: segment 1 (GOPs 2-3) can't be built, segment 2 (4-5) can.
    expect(fs.existsSync(path.join(dir, 'seg-0001.m4s'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'seg-0002.m4s'))).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('landed on GOP 3'));
  });

  it('moves a first frame a tick before 0 onto 0, and says so', async () => {
    // The run's edit is a tick longer than the probe's reorder delay.
    fs.writeFileSync(
      path.join(gopDir, 'init.mp4'),
      box('moov', Buffer.concat([trak(1, 1000, 'vide', 81), trak(2, 48000, 'soun', 0)])),
    );
    fs.writeFileSync(path.join(gopDir, 'gop-0.m4s'), gop(0n, 0n));
    await assemble(0, null, 0);
    expect(tfdts(fs.readFileSync(path.join(dir, 'seg-0000.m4s')))[0]).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('1 ticks before 0'));
  });

  it('refuses a GOP file that opens another keyframe than planned', async () => {
    // ffmpeg skipped the cut at 2 s: file 1 opens the keyframe at 4 s.
    [0, 4, 6, 8, 10].forEach((t, i) =>
      fs.writeFileSync(path.join(gopDir, `gop-${i}.m4s`), gop(BigInt(t * 1000), BigInt(t * 48000))),
    );
    const onFailure = jest.fn();
    const asm = assembler(0, null, 0, grid, onFailure);
    const pass = async () => {
      (asm as unknown as { kick(): void }).kick();
      await (asm as unknown as { chain: Promise<void> }).chain;
    };
    for (let i = 0; i < 3; i++) await pass();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('GOP file 1 starts at 4.000s, on keyframe 2 (4s), not the planned 1 (2s)'),
    );
    expect(segs()).toEqual([]);
  });

  it('copies media data larger than its copy buffer through untouched', async () => {
    const data = [0, 1].map((i) => Buffer.alloc(3 * 1024 * 1024 + 7, i + 1));
    [0, 2, 4].forEach((t, i) => {
      const frags = gop(BigInt(t * 1000), BigInt(t * 48000));
      fs.writeFileSync(
        path.join(gopDir, `gop-${i}.m4s`),
        Buffer.concat([frags, box('mdat', data[i] ?? Buffer.alloc(1))]),
      );
    });
    await assemble(0, null, 0, grid, false);
    const seg = fs.readFileSync(path.join(dir, 'seg-0000.m4s'));
    for (const d of data) expect(seg.includes(d)).toBe(true);
    expect(tfdts(seg)).toEqual([0, audioEdit, 2000, 2 * 48000 + audioEdit]);
  });

  it('takes one ffmpeg segment per served one without a keyframe list', async () => {
    [0, 1].forEach((i) =>
      fs.writeFileSync(path.join(gopDir, `gop-${i}.m4s`), gop(BigInt(i * 3000 + 80), BigInt(i * 144000))),
    );
    await assemble(0, null, 0, null);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('seg-')).sort()).toEqual([
      'seg-0000.m4s',
      'seg-0001.m4s',
    ]);
  });

  it('assembles a segment once its own decode reaches the next keyframe, with no need for the next GOP to start', async () => {
    // The target time comes from the grid, not from gop-4: no wait for it.
    writeGops(4);
    await assemble(0, null, 0, grid, false);
    expect(segs()).toEqual(['seg-0000.m4s', 'seg-0001.m4s']);
  });

  it('exposes the frontier one past the last produced segment, short of the tail until a clean exit', async () => {
    const asm = assembler(0, null, 0);
    expect(asm.videoFrontier()).toBeNull(); // not opened: no GOP has landed yet
    writeGops(4);
    asm.start();
    await asm.finish(false); // killed, not exited cleanly: no tail
    expect(asm.videoFrontier()).toBe(2); // seg-0000, seg-0001 produced; seg-0002 (tail) is not
  });

  it('advances the frontier past the tail once a clean exit assembles the last segment', async () => {
    writeGops(6);
    const asm = assembler(0, null, 0);
    asm.start();
    await asm.finish(true);
    expect(asm.videoFrontier()).toBe(3); // one past seg-0002, the tail assembleTail() just wrote
  });

  it('never assembles a GOP whose decode falls short of its next keyframe, however it was renamed', async () => {
    // ffmpeg's own SIGTERM trailer can rename a mid-GOP cut as if it were done.
    fs.writeFileSync(path.join(gopDir, 'gop-0.m4s'), gop(0n, 0n));
    fs.writeFileSync(path.join(gopDir, 'gop-1.m4s'), gop(2000n, 96000n, 200));
    await assemble(0, null, 0, grid, false);
    expect(segs()).toEqual([]);
  });

  it("doesn't let a clean exit code publish a GOP a truncated trailer only renamed", async () => {
    // ffmpeg reports code 0 after a graceful SIGTERM too: assembleTail must
    // still refuse a last GOP whose own decode never reached its target.
    writeGops(2);
    fs.writeFileSync(path.join(gopDir, 'gop-2.m4s'), gop(4000n, 192000n, 200));
    await assemble(0, null, 0, grid, true);
    expect(segs()).toEqual(['seg-0000.m4s']);
  });

  it('leaves a segment out while its last GOP is still .tmp', async () => {
    writeGops(2);
    fs.writeFileSync(path.join(gopDir, 'gop-2.m4s.tmp'), Buffer.alloc(0));
    fs.writeFileSync(path.join(gopDir, 'gop-3.m4s.tmp'), Buffer.alloc(0));
    await assemble(0, null, 0, grid, false);
    expect(segs()).toEqual(['seg-0000.m4s']);
  });

  it('keeps a segment another run already built and drops its GOPs', async () => {
    fs.writeFileSync(path.join(dir, 'seg-0000.m4s'), 'served');
    writeGops(3);
    await assemble(0, null, 0, grid, false);
    expect(fs.readFileSync(path.join(dir, 'seg-0000.m4s'), 'utf8')).toBe('served');
    expect(fs.existsSync(gopDir)).toBe(false);
  });

  it('retries a rename a scanner holds, then carries on', async () => {
    writeGops(3);
    const rename = jest.spyOn(fs.promises, 'rename');
    rename.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }));
    try {
      await assemble(0, null, 0, grid, false);
    } finally {
      rename.mockRestore();
    }
    expect(segs()).toEqual(['seg-0000.m4s']);
  });

  it('retries a failing segment on later passes, then stops the run', async () => {
    writeGops(3);
    const onFailure = jest.fn();
    const asm = assembler(0, null, 0, grid, onFailure);
    const write = jest.spyOn(fs.promises, 'open');
    write.mockRejectedValue(Object.assign(new Error('quota'), { code: 'EDQUOT' }));
    try {
      const pass = async () => {
        (asm as unknown as { kick(): void }).kick();
        await (asm as unknown as { chain: Promise<void> }).chain;
      };
      await pass();
      await pass();
      expect(onFailure).not.toHaveBeenCalled();
      await pass();
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('stopped at segment 0: quota'));
    } finally {
      write.mockRestore();
    }
    expect(segs()).toEqual([]);
  });
});

const TFHD_BASE_IS_MOOF = 0x020000;
const TRUN_EXPLICIT_SAMPLE = 0x000001 | 0x000100 | 0x000200 | 0x000400;
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(n); // signed: a priming frame's tfdt can be negative
  return b;
};
const fullbox = (version: number, flags: number) => u32((version << 24) | flags);

/** One raw audio frame as `buildMultiAudioOutputs` produces it: a single
 *  sample per fragment (`frag_every_frame`), explicit trun fields. */
const audioFrame = (trackId: number, tfdt: bigint): Buffer => {
  const trun = box(
    'trun',
    Buffer.concat([fullbox(0, TRUN_EXPLICIT_SAMPLE), u32(1), u32(0), u32(1024), u32(2), u32(0x02000000)]),
  );
  const tfhd = box('tfhd', Buffer.concat([fullbox(0, TFHD_BASE_IS_MOOF), u32(trackId)]));
  const tfdtBox = box('tfdt', Buffer.concat([fullbox(1, 0), u64(tfdt)]));
  return Buffer.concat([
    box('moof', box('traf', Buffer.concat([tfhd, tfdtBox, trun]))),
    box('mdat', Buffer.alloc(2)),
  ]);
};

/** ffmpeg's growing per-track output: ftyp + moov, then one fragment
 *  per source frame, all in the one file this tails as it grows. */
const audioTrackFile = (trackId: number, timescale: number, tfdts: bigint[]): Buffer =>
  Buffer.concat([
    box('ftyp', Buffer.alloc(4)),
    box('moov', trak(trackId, timescale, 'soun', 0)),
    ...tfdts.map((t) => audioFrame(trackId, t)),
  ]);

const sampleCounts = (buf: Buffer): number[] => {
  const out: number[] = [];
  for (let i = buf.indexOf('trun'); i !== -1; i = buf.indexOf('trun', i + 4)) {
    out.push(buf.readUInt32BE(i + 8));
  }
  return out;
};

describe('RemuxSegmentAssembler: multi-audio (one growing file per track)', () => {
  let dir: string;
  let gopDir: string;

  const videoOnlyGop = (tfdt: bigint): Buffer => {
    const t = Buffer.alloc(8);
    t.writeBigInt64BE(tfdt);
    return Buffer.concat([
      box(
        'moof',
        box(
          'traf',
          Buffer.concat([
            box('tfhd', Buffer.concat([Buffer.alloc(4), u32(1)])),
            box('tfdt', Buffer.concat([Buffer.from([1, 0, 0, 0]), t])),
            videoTrun(GOP_DECODE_SPAN_TICKS),
          ]),
        ),
      ),
      box('mdat', Buffer.alloc(2)),
    ]);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remux-asm-multi-'));
    gopDir = path.join(dir, 'gop-run');
    fs.mkdirSync(gopDir, { recursive: true });
    fs.writeFileSync(path.join(gopDir, 'init.mp4'), box('moov', trak(1, 1000, 'vide', 80)));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writeVideoGops = (times: number[]) =>
    times.forEach((t, i) =>
      fs.writeFileSync(path.join(gopDir, `gop-${i}.m4s`), videoOnlyGop(BigInt(t * 1000))),
    );
  const writeAudioTrack = (index0: number, trackId: number, times: number[]) =>
    fs.writeFileSync(
      path.join(gopDir, `a${index0}.mp4`),
      audioTrackFile(trackId, 48000, times.map((t) => BigInt(Math.round(t * 48000)))),
    );
  const segsIn = (d: string) => fs.readdirSync(d).filter((f) => f.startsWith('seg-')).sort();
  const plan = (
    grid_: typeof grid | null,
    extra: { segmentDuration?: number; origin?: number } = {},
  ) =>
    remuxAssemblyPlan({
      dir,
      gopDir,
      grid: grid_,
      startSegment: 0,
      run: { audioStartSeconds: 0, seekSeconds: null, startNumber: 0 },
      origin: 0,
      audioRenditions: 1,
      ...extra,
    });

  it('coalesces per-frame fragments into one moof/trun per served segment', async () => {
    // 6 keyframes (0,2,4,6,8,10) → 3 served segments of 4s (boundaries 0,4,8,12).
    writeVideoGops([0, 2, 4, 6, 8, 10]);
    // ffmpeg writes one fragment per frame, one file per second here, none
    // aligned with the video's 4s grid; the assembler groups them onto it.
    writeAudioTrack(0, 10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const asm = new RemuxSegmentAssembler(plan(grid), log, 'test-multi');
    expect(asm.videoFrontier()).toBeNull();
    expect(asm.audioFrontier(1)).toBeNull();
    asm.start();
    await asm.finish(true);

    // One past the last produced segment on both tracks, tail included.
    expect(asm.videoFrontier()).toBe(3);
    expect(asm.audioFrontier(1)).toBe(3);
    expect(asm.audioFrontier(2)).toBeNull();

    expect(segsIn(dir)).toEqual(['seg-0000.m4s', 'seg-0001.m4s', 'seg-0002.m4s']);
    const rendition = path.join(dir, '1');
    // The last fragment (t=11) is proven complete only once the run ends:
    // the tail flush must still pick it up (no a0.mp4 growth ever proven by a "next").
    expect(segsIn(rendition)).toEqual(['seg-0000.m4s', 'seg-0001.m4s', 'seg-0002.m4s']);
    for (const n of [0, 1, 2]) {
      const buf = fs.readFileSync(path.join(rendition, `seg-000${n}.m4s`));
      expect(tfdts(buf)).toHaveLength(1); // one moof, not one per source frame
      expect(sampleCounts(buf)).toEqual([4]);
    }
    expect(fs.existsSync(gopDir)).toBe(false);
  });

  it('skips a served segment with no audio at all: a track that ends early', async () => {
    writeVideoGops([0, 2, 4, 6, 8, 10]);
    // Only the first two segments' worth of audio; the third (8-12s) never
    // gets a frame, mirroring a copied track shorter than the video.
    writeAudioTrack(0, 10, [0, 1, 2, 3, 4, 5, 6, 7]);
    const asm = new RemuxSegmentAssembler(plan(grid), log, 'test-multi-short');
    asm.start();
    await asm.finish(true);
    expect(segsIn(path.join(dir, '1'))).toEqual(['seg-0000.m4s', 'seg-0001.m4s']);
  });

  it('groups by time onto the uniform fallback grid too, not 1 file = 1 segment', async () => {
    writeVideoGops([0, 1]);
    // Frames at 0s and exactly the 3s (default segmentDuration) boundary.
    writeAudioTrack(0, 10, [0, 3]);
    const asm = new RemuxSegmentAssembler(plan(null), log, 'test-multi-uniform');
    asm.start();
    await asm.finish(true);
    expect(segsIn(path.join(dir, '1'))).toEqual(['seg-0000.m4s', 'seg-0001.m4s']);
  });

  it('anchors the uniform fallback grid on the plan origin, not the run\'s own landing point', async () => {
    // Origin 10s, 3s segments: a run from segment 0 needs no -ss, so its raw
    // tfdt is already the absolute source time, same as video's own cut.
    writeVideoGops([10, 13]);
    writeAudioTrack(0, 10, [10, 13]);
    const asm = new RemuxSegmentAssembler(plan(null, { origin: 10 }), log, 'test-multi-origin');
    asm.start();
    await asm.finish(true);
    expect(segsIn(path.join(dir, '1'))).toEqual(['seg-0000.m4s', 'seg-0001.m4s']);
  });

  it("keeps a run-from-0 track's own priming instead of dropping it, like the single-audio path", async () => {
    writeVideoGops([0, 2, 4, 6, 8, 10]);
    // Two frames ahead of the file's own start (real encoder priming), then
    // the real content: segment 0 has no earlier run's segment to protect.
    writeAudioTrack(0, 10, [-0.02, -0.01, 0, 1, 2, 3]);
    const asm = new RemuxSegmentAssembler(plan(grid), log, 'test-multi-first-priming');
    asm.start();
    await asm.finish(true);
    const seg0 = fs.readFileSync(path.join(dir, '1', 'seg-0000.m4s'));
    expect(sampleCounts(seg0)).toEqual([6]);
  });

  it("drops a seeked run's own priming fragments instead of prepending them", async () => {
    // Segment 1 (boundary 4s), same run as the single-rendition "adds back
    // the output -ss" test above: -ss 3.9195 rounds to 3.920, so a run-local
    // time is its absolute source time less 3.92.
    [4, 6, 8, 10].forEach((t, k) =>
      fs.writeFileSync(
        path.join(gopDir, `gop-${2 + k}.m4s`),
        videoOnlyGop(BigInt(Math.round((t - 3.92) * 1000))),
      ),
    );
    // Absolute source times 3.9, 3.95 (priming, before the 4s boundary), then
    // the real 4, 5, 6, 7: all run-local (less 3.92), timescale 48000.
    fs.writeFileSync(
      path.join(gopDir, 'a0.mp4'),
      audioTrackFile(
        10,
        48000,
        [3.9, 3.95, 4, 5, 6, 7].map((t) => BigInt(Math.round((t - 3.92) * 48000))),
      ),
    );
    const asm = new RemuxSegmentAssembler(
      remuxAssemblyPlan({
        dir,
        gopDir,
        grid,
        startSegment: 1,
        run: { audioStartSeconds: 0, seekSeconds: 3.9195, startNumber: 2 },
        origin: 0,
        audioRenditions: 1,
      }),
      log,
      'test-multi-seek',
    );
    asm.start();
    await asm.finish(true);
    const seg1 = fs.readFileSync(path.join(dir, '1', 'seg-0001.m4s'));
    // The 4 real samples (4,5,6,7s): the 3.9/3.95 priming is dropped, not
    // folded into segment 1 ahead of its real first sample (would give 6).
    expect(sampleCounts(seg1)).toEqual([4]);
  });

  it('treats a delta of exactly 0n as already resolved, not "not yet open"', async () => {
    // A run whose audio priming headroom and correction net to exactly 0
    // ticks: `!a.delta` (falsy on 0n) would re-run openAudioRun forever.
    const zeroGrid = computeSegmentGrid([{ pts: 0, dts: 0.14 }], 0, 4, 4)!;
    fs.writeFileSync(path.join(gopDir, 'init.mp4'), box('moov', trak(1, 1000, 'vide', 0)));
    writeVideoGops([0]);
    writeAudioTrack(0, 10, [0]);
    const asm = new RemuxSegmentAssembler(plan(zeroGrid), log, 'test-multi-zero-delta');
    const mkdir = jest.spyOn(fs.promises, 'mkdir');
    const kick = () => (asm as unknown as { kick(): void }).kick();
    const settle = () => (asm as unknown as { chain: Promise<void> }).chain;
    asm.start();
    kick();
    await settle();
    kick();
    await settle();
    kick();
    await settle();
    const audioDirCalls = mkdir.mock.calls.filter((c) => c[0] === path.join(dir, '1'));
    mkdir.mockRestore();
    expect(audioDirCalls).toHaveLength(1);
    await asm.finish(true);
  });

  it("logs and fails the run when a track's init never becomes parseable", async () => {
    writeVideoGops([0, 2, 4, 6, 8, 10]);
    // Not a parseable moov: the track can never open, so this must fail fast
    // instead of silently never publishing the rendition.
    fs.writeFileSync(path.join(gopDir, 'a0.mp4'), Buffer.concat([box('ftyp', Buffer.alloc(4)), box('moov', Buffer.alloc(0))]));
    const onFailure = jest.fn();
    const asm = new RemuxSegmentAssembler(plan(grid), log, 'test-multi-bad-init', onFailure);
    const kick = () => (asm as unknown as { kick(): void }).kick();
    const settle = () => (asm as unknown as { chain: Promise<void> }).chain;
    asm.start();
    for (let i = 0; i < 3; i++) {
      kick();
      await settle();
    }
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('audio rendition 1 assembly stopped'),
    );
    await asm.finish(true);
  });

  it("isolates one track's failures from the video's own counter and log wording", async () => {
    writeVideoGops([0, 2, 4, 6, 8, 10]);
    fs.writeFileSync(path.join(gopDir, 'a0.mp4'), Buffer.concat([box('ftyp', Buffer.alloc(4)), box('moov', Buffer.alloc(0))]));
    const onFailure = jest.fn();
    const errorCallsBefore = (log.error as jest.Mock).mock.calls.length;
    const asm = new RemuxSegmentAssembler(plan(grid), log, 'test-multi-isolate', onFailure);
    const kick = () => (asm as unknown as { kick(): void }).kick();
    const settle = () => (asm as unknown as { chain: Promise<void> }).chain;
    asm.start();
    for (let i = 0; i < 3; i++) {
      kick();
      await settle();
    }
    // Video assembles every segment (its own last GOP is already renamed, no
    // tail needed), untouched by the audio track's own failures.
    expect(segsIn(dir)).toEqual(['seg-0000.m4s', 'seg-0001.m4s', 'seg-0002.m4s']);
    expect(onFailure).toHaveBeenCalledTimes(1);
    const newErrors = (log.error as jest.Mock).mock.calls.slice(errorCallsBefore);
    expect(newErrors).toEqual([[expect.stringContaining('audio rendition 1 assembly stopped')]]);
    await asm.finish(true);
  });
});

describe('RemuxSegmentAssembler.canServe (wait vs respawn)', () => {
  const bare = (startSegment: number) =>
    new RemuxSegmentAssembler(
      remuxAssemblyPlan({
        dir: '/x',
        gopDir: '/x/gop',
        grid: null,
        startSegment,
        run: { audioStartSeconds: 0, seekSeconds: null, startNumber: startSegment },
        origin: 0,
      }),
      log,
      'test-canserve',
    );
  /** Poke the run open with a video frontier at `next`, and a throughput of
   *  `(next - openStartSegment) / (elapsedMs / 1000)` (null: unmeasured). */
  const open = (
    asm: RemuxSegmentAssembler,
    next: number,
    openStartSegment: number,
    elapsedMs: number | null,
  ): RemuxSegmentAssembler => {
    Object.assign(
      asm as unknown as { opened: boolean; next: number; openStartSegment: number; openedAt: number | null },
      { opened: true, next, openStartSegment, openedAt: elapsedMs == null ? null : Date.now() - elapsedMs },
    );
    return asm;
  };

  it("is false below the run's own start: it will never produce a segment behind it", () => {
    const asm = open(bare(10), 12, 10, 1000);
    expect(asm.canServe(5, undefined, false)).toBe(false);
    expect(asm.canServe(5, undefined, true)).toBe(false);
  });

  it('is true for a segment already produced (below the frontier)', () => {
    const asm = open(bare(10), 20, 10, 1000);
    expect(asm.canServe(11, undefined, false)).toBe(true);
    expect(asm.canServe(11, undefined, true)).toBe(true);
  });

  it('a live run is true just past the frontier, within its wait window', () => {
    // Throughput 10/s, buffer 3s, cap 3: window caps at 3.
    const asm = open(bare(10), 20, 10, 1000);
    expect(asm.canServe(22, undefined, false)).toBe(true);
    expect(asm.canServe(24, undefined, false)).toBe(false);
  });

  it("an exited run is a hard boundary at the frontier: no buffer-ahead, whatever a live run's window would allow", () => {
    const asm = open(bare(10), 20, 10, 1000);
    expect(asm.canServe(20, undefined, true)).toBe(false);
    expect(asm.canServe(20, undefined, false)).toBe(true); // same segment, still running: within window
  });

  it("an unopened run is reachable only within the wait window of its own start", () => {
    const asm = bare(0); // never opened: no frontier, no throughput
    expect(asm.canServe(2, undefined, false)).toBe(true);
    expect(asm.canServe(9, undefined, false)).toBe(false);
    expect(asm.canServe(2, undefined, true)).toBe(false); // exited with no frontier: never produced anything
  });

  it('shrinks the wait window for a slow run, never below 1', () => {
    // Throughput 0.05/s: round(0.05 * 3) = 0, floored to 1; frontier 1 + window 1 = 2.
    const asm = open(bare(0), 1, 0, 20_000);
    expect(asm.canServe(2, undefined, false)).toBe(true);
    expect(asm.canServe(3, undefined, false)).toBe(false);
  });

  it("one rendition's own frontier is independent of the video's", () => {
    const asm = bare(0);
    open(asm, 5, 0, 1000); // video produced up to 5
    (asm as unknown as { audio: { index: number; served: number }[] }).audio = [{ index: 1, served: 2 }];
    expect(asm.canServe(1, 1, true)).toBe(true); // rendition 1 already produced this
    expect(asm.canServe(3, 1, true)).toBe(false); // rendition 1 hasn't reached it yet
    expect(asm.canServe(3, undefined, true)).toBe(true); // video has
  });

  describe('throttle pause/resume: canServe must not be fooled by a paused run', () => {
    /** Same shape as `open()` above, plus a directly-injected `pausedMs` , 
     *  the throttle service's own pause()/resume() only measure real time,
     *  so a deterministic test sets the accumulated pause straight. */
    const openPaused = (
      asm: RemuxSegmentAssembler,
      next: number,
      openStartSegment: number,
      wallClockElapsedMs: number,
      pausedMs: number,
    ): RemuxSegmentAssembler => {
      Object.assign(
        asm as unknown as {
          opened: boolean;
          next: number;
          openStartSegment: number;
          openedAt: number | null;
          pausedMs: number;
        },
        {
          opened: true,
          next,
          openStartSegment,
          openedAt: Date.now() - wallClockElapsedMs,
          pausedMs,
        },
      );
      return asm;
    };

    it('excludes paused wall-clock time from measured throughput', () => {
      // 6s wall clock, 5s of it paused: producing time is 1s for 3 segments → 3/s,
      // window round(3*3)=9 capped to REMUX_MAX_WAIT_SEGMENTS(3). Frontier 13.
      const throttled = openPaused(bare(10), 13, 10, 6000, 5000);
      expect(throttled.canServe(16, undefined, false)).toBe(true);

      // Same wall clock, nothing excluded: 3 segments / 6s = 0.5/s, window
      // round(0.5*3)=2. Frontier 13 + 2 = 15, so 16 is out of reach.
      const unthrottled = openPaused(bare(10), 13, 10, 6000, 0);
      expect(unthrottled.canServe(16, undefined, false)).toBe(false);
    });

    it('pause() then resume() accumulate exactly the paused span', () => {
      jest.useFakeTimers();
      try {
        const asm = bare(0);
        Object.assign(
          asm as unknown as { opened: boolean; next: number; openStartSegment: number; openedAt: number | null },
          { opened: true, next: 5, openStartSegment: 0, openedAt: Date.now() },
        );
        jest.advanceTimersByTime(2000); // 2s producing
        asm.pause();
        jest.advanceTimersByTime(3000); // 3s paused, excluded
        asm.resume();
        jest.advanceTimersByTime(1000); // 1s more producing
        // Wall clock 6s, paused 3s → producing elapsed 3s → 5 segments / 3s.
        expect(asm.segmentsPerSecond()).toBeCloseTo(5 / 3, 5);
      } finally {
        jest.useRealTimers();
      }
    });

    it('reads Infinity-free null while a pause is still open and openedAt is unset', () => {
      const asm = bare(0);
      expect(asm.segmentsPerSecond()).toBeNull();
      asm.pause(); // no-op before the run has opened
      expect(asm.segmentsPerSecond()).toBeNull();
    });
  });

  describe('RemuxSegmentAssembler.frontierSeconds', () => {
    it('is null before the run has opened', () => {
      expect(bare(0).frontierSeconds()).toBeNull();
    });

    it('falls back to the uniform grid when there is no keyframe grid', () => {
      const asm = open(bare(10), 13, 10, 1000); // DEFAULT_SEGMENT_DURATION=3, origin 0
      expect(asm.frontierSeconds()).toBeCloseTo(13 * 3, 5);
    });

    it('reads the real grid boundary at the frontier segment when one exists', () => {
      const withGrid = new RemuxSegmentAssembler(
        remuxAssemblyPlan({
          dir: '/x',
          gopDir: '/x/gop',
          grid,
          startSegment: 0,
          run: { audioStartSeconds: 0, seekSeconds: null, startNumber: 0 },
          origin: 0,
        }),
        log,
        'test-frontier-grid',
      );
      open(withGrid, 2, 0, 1000);
      expect(withGrid.frontierSeconds()).toBe(grid.boundaries[2]);
    });
  });
});
