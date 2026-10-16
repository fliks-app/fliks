import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { edlPathFor, readEdlSidecar, resetEdlSidecarState, shiftRanges } from './edl-sidecar';

describe('edlPathFor', () => {
  it('swaps the extension and keeps dots in the name', () => {
    expect(edlPathFor('/m/Show.S01E01.1080p.mkv')).toBe('/m/Show.S01E01.1080p.edl');
    expect(edlPathFor('/m/noext')).toBe('/m/noext.edl');
  });
});

describe('readEdlSidecar', () => {
  let dir: string;
  const video = () => path.join(dir, 'a.mkv');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edl-'));
    resetEdlSidecarState();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns null without a sidecar, or when the .edl is a directory', async () => {
    expect(await readEdlSidecar(video())).toBeNull();
    fs.mkdirSync(path.join(dir, 'a.edl'));
    expect(await readEdlSidecar(video())).toBeNull();
  });

  it('parses, and re-reads once the file changes', async () => {
    const edl = path.join(dir, 'a.edl');
    fs.writeFileSync(edl, '1 2 0\n');
    expect(await readEdlSidecar(video())).toEqual([{ start: 1, end: 2, action: 'cut' }]);
    fs.writeFileSync(edl, '1 2 0\n5 6 1\n');
    expect((await readEdlSidecar(video()))?.length).toBe(2);
  });

  it('uses fps for frame lines and returns [] when every line is rejected', async () => {
    fs.writeFileSync(path.join(dir, 'a.edl'), '#50 #100 0\n');
    expect(await readEdlSidecar(video(), 25)).toEqual([{ start: 2, end: 4, action: 'cut' }]);
    expect(await readEdlSidecar(video())).toEqual([]);
  });

  it('finds the sidecar whatever its letter case', async () => {
    fs.writeFileSync(path.join(dir, 'A.EDL'), '1 2 0\n');
    expect(await readEdlSidecar(video())).toEqual([{ start: 1, end: 2, action: 'cut' }]);
  });

  it('ignores a file over 1 MiB', async () => {
    fs.writeFileSync(path.join(dir, 'a.edl'), '#'.repeat(1024 * 1024 + 1));
    expect(await readEdlSidecar(video())).toBeNull();
  });
});

describe('shiftRanges', () => {
  const ranges = [
    { start: 0, end: 5, action: 'cut' as const },
    { start: 10, end: 20, action: 'mute' as const },
  ];

  it('shifts by the playback clock offset and clamps at zero', () => {
    const out = shiftRanges(ranges, -0.1);
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBeCloseTo(4.9);
    expect(out[1].start).toBeCloseTo(9.9);
  });

  it('rounds to the millisecond after the shift and drops empty ranges', () => {
    const out = shiftRanges([{ start: 1, end: 2, action: 'cut' }, { start: 0.0004, end: 0.0006, action: 'mute' }], 0.1234567);
    expect(out).toEqual([{ start: 1.123, end: 2.123, action: 'cut' }]);
  });

  it('drops ranges that end up before the origin', () => {
    expect(shiftRanges([{ start: 0, end: 1, action: 'cut' }], -2)).toEqual([]);
  });
});
