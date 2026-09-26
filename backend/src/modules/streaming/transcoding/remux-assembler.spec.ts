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
import { readInitEdits } from './timeline';

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const box = (type: string, payload: Buffer) =>
  Buffer.concat([u32(8 + payload.length), Buffer.from(type, 'latin1'), payload]);

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

/** A GOP file: one video and one audio fragment, v1 tfdt. */
function gop(videoTfdt: bigint, audioTfdt: bigint): Buffer {
  const frag = (id: number, v: bigint) => {
    const t = Buffer.alloc(8);
    t.writeBigInt64BE(v);
    return box(
      'moof',
      box(
        'traf',
        Buffer.concat([
          box('tfhd', Buffer.concat([Buffer.alloc(4), u32(id)])),
          box('tfdt', Buffer.concat([Buffer.from([1, 0, 0, 0]), t])),
        ]),
      ),
    );
  };
  return Buffer.concat([frag(1, videoTfdt), box('mdat', Buffer.alloc(2)), frag(2, audioTfdt)]);
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
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remux-asm-'));
    gopDir = path.join(dir, 'gop-run');
    fs.mkdirSync(gopDir);
    // ffmpeg's run init: video starts 2 frames into its media, audio at once.
    fs.writeFileSync(
      path.join(gopDir, 'init.mp4'),
      box('moov', Buffer.concat([trak(1, 1000, 'vide', 80), trak(2, 48000, 'soun', 0)])),
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const assemble = async (
    startSegment: number,
    seekSeconds: number | null,
    startNumber: number,
    g: typeof grid | null = grid,
  ) => {
    const asm = new RemuxSegmentAssembler(
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
    );
    asm.start();
    await asm.finish(true);
  };
  const edits = remuxEdits(grid, 0);
  const audioEdit = Math.round(edits.audio * 48000);

  it('lifts a grid that starts before 0 onto 0', () => {
    const wrapped = computeSegmentGrid(
      [-23.72, -21.72].map((pts) => ({ pts, dts: pts - 0.08 })),
      -23.72,
      -19.72,
      2,
    )!;
    const e = remuxEdits(wrapped, -23.72);
    expect(e.shift).toBeCloseTo(23.72, 9);
    expect(e.video).toBeCloseTo(0.08, 9);
    // The audio headroom counts on the lifted timeline, where it starts at 0.
    expect(e.audio).toBeCloseTo(0.128 + 0.08 + 0.01, 9);
  });

  it('derives the edits from the first keyframe', () => {
    expect(edits.video).toBeCloseTo(0.08, 9);
    // Priming headroom from under the run-from-start seek.
    expect(edits.audio).toBeCloseTo(0.128 + 0.08 + 0.01, 9);
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
    // tfdt stays its first frame. Audio moves up by its headroom.
    const seg1 = fs.readFileSync(path.join(dir, 'seg-0001.m4s'));
    expect(tfdts(seg1)).toEqual([
      4000,
      Math.round((4 - 0.021) * 48000) + audioEdit,
      6000,
      Math.round((6 - 0.021) * 48000) + audioEdit,
    ]);
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
});
