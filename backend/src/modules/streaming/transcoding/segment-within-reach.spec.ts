import * as fsp from 'fs/promises';
import * as path from 'path';
import { segmentWithinReach } from './segment-utils';

const ROOT = '/tmp/fliks-within-reach-test';

function seg(n: number): string {
  return `seg-${String(n).padStart(4, '0')}.m4s`;
}

async function writeSegs(dir: string, from: number, to: number): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  for (let n = from; n <= to; n++) {
    await fsp.writeFile(path.join(dir, seg(n)), 'x');
  }
}

describe('segmentWithinReach', () => {
  beforeEach(async () => {
    await fsp.rm(ROOT, { recursive: true, force: true });
  });
  afterEach(async () => {
    await fsp.rm(ROOT, { recursive: true, force: true });
  });

  it('is true when the encoder frontier sits within lookback behind the request', async () => {
    const dir = path.join(ROOT, 'near');
    // Frontier at segment 200, mid-stream; client asks for 205 (buffer-ahead).
    await writeSegs(dir, 0, 200);
    expect(await segmentWithinReach(dir, 205, 15)).toBe(true);
  });

  it('is false when the request is further than lookback past the frontier', async () => {
    const dir = path.join(ROOT, 'far');
    // Frontier at 200; a real seek to 250 is 50 segments ahead.
    await writeSegs(dir, 0, 200);
    expect(await segmentWithinReach(dir, 250, 15)).toBe(false);
  });

  it('does not let the start segment widen the grace window (mid-stream lag is not a seek)', async () => {
    const dir = path.join(ROOT, 'midstream');
    // The frontier (180), not startSegment (0), bounds the grace: a request 2
    // ahead of a deep frontier must wait, exactly as it would near segment 0.
    await writeSegs(dir, 0, 180);
    expect(await segmentWithinReach(dir, 182, 15)).toBe(true);
    expect(await segmentWithinReach(dir, 200, 15)).toBe(false);
  });

  it('checks the var_stream_map 0/ subdir as well as the flat layout', async () => {
    const dir = path.join(ROOT, 'vsm');
    await writeSegs(path.join(dir, '0'), 0, 100);
    expect(await segmentWithinReach(dir, 103, 15)).toBe(true);
  });

  it('is false on an empty cache (nothing produced yet)', async () => {
    const dir = path.join(ROOT, 'empty');
    await fsp.mkdir(dir, { recursive: true });
    expect(await segmentWithinReach(dir, 5, 15)).toBe(false);
  });
});
