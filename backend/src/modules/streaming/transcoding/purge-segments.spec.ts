import * as fsp from 'fs/promises';
import * as path from 'path';
import { purgeSegmentsFrom } from './segment-utils';

const ROOT = '/tmp/fliks-purge-test';

function seg(n: number): string {
  return `seg-${String(n).padStart(4, '0')}.m4s`;
}

async function writeSegs(
  dir: string,
  from: number,
  to: number,
  withInit = false,
): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  if (withInit) await fsp.writeFile(path.join(dir, 'init_0.mp4'), 'x');
  for (let n = from; n <= to; n++) {
    await fsp.writeFile(path.join(dir, seg(n)), 'x');
  }
}

async function listSegs(dir: string): Promise<number[]> {
  const files = await fsp.readdir(dir).catch(() => [] as string[]);
  return files
    .map((f) => /^seg-(\d+)\.m4s$/.exec(f)?.[1])
    .filter((v): v is string => v != null)
    .map((v) => parseInt(v, 10))
    .sort((a, b) => a - b);
}

describe('purgeSegmentsFrom', () => {
  beforeEach(async () => {
    await fsp.rm(ROOT, { recursive: true, force: true });
  });
  afterEach(async () => {
    await fsp.rm(ROOT, { recursive: true, force: true });
  });

  it('drops segments >= fromSegment in the flat layout, keeps the rest + init', async () => {
    const dir = path.join(ROOT, 'flat');
    await writeSegs(dir, 0, 10, /* withInit */ true);

    await purgeSegmentsFrom(dir, 5);

    expect(await listSegs(dir)).toEqual([0, 1, 2, 3, 4]);
    await expect(fsp.access(path.join(dir, 'init_0.mp4'))).resolves.toBeUndefined();
  });

  it('purges across var_stream_map numeric subdirs (0/,1/,2/)', async () => {
    const dir = path.join(ROOT, 'vsm');
    await writeSegs(path.join(dir, '0'), 100, 110);
    await writeSegs(path.join(dir, '1'), 100, 110);
    await writeSegs(path.join(dir, '2'), 100, 110);

    await purgeSegmentsFrom(dir, 105);

    for (const v of ['0', '1', '2']) {
      expect(await listSegs(path.join(dir, v))).toEqual([100, 101, 102, 103, 104]);
    }
  });

  it('fromSegment=0 clears every segment (cold-restart wipe)', async () => {
    const dir = path.join(ROOT, 'wipe');
    await writeSegs(path.join(dir, '0'), 2089, 2095);

    await purgeSegmentsFrom(dir, 0);

    expect(await listSegs(path.join(dir, '0'))).toEqual([]);
  });

  it('is a no-op on a missing directory', async () => {
    await expect(
      purgeSegmentsFrom(path.join(ROOT, 'does-not-exist'), 3),
    ).resolves.toBeUndefined();
  });
});
