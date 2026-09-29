import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ATOMIC_TEMP_PREFIX, writeAtomically, writeFileAtomic } from './atomic-file';

describe('atomic file writes', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('gives two writers of one destination a temp each', async () => {
    const dest = path.join(dir, 'seg-0001.m4s');
    const temps: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = writeAtomically(dest, async (tmp) => {
      temps.push(tmp);
      fs.writeFileSync(tmp, 'first');
      await gate;
    });
    await writeAtomically(dest, async (tmp) => {
      temps.push(tmp);
      fs.writeFileSync(tmp, 'second');
    });
    release();
    await slow;
    expect(new Set(temps).size).toBe(2);
    expect(temps.every((t) => path.basename(t).startsWith(ATOMIC_TEMP_PREFIX))).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['seg-0001.m4s']);
  });

  it('leaves no temp and no destination when the write fails', async () => {
    const dest = path.join(dir, 'init.mp4');
    await expect(
      writeAtomically(dest, async (tmp) => {
        fs.writeFileSync(tmp, 'partial');
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('retries a rename a scanner holds', async () => {
    const rename = jest.spyOn(fs.promises, 'rename');
    rename.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }));
    try {
      await writeFileAtomic(path.join(dir, 'a.json'), '{}');
    } finally {
      rename.mockRestore();
    }
    expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('{}');
  });

  it('does not retry EACCES outside Windows, where it is a real permission error', async () => {
    if (process.platform === 'win32') return;
    const rename = jest.spyOn(fs.promises, 'rename');
    rename.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    try {
      await expect(writeFileAtomic(path.join(dir, 'b.json'), '{}')).rejects.toThrow('denied');
      expect(rename).toHaveBeenCalledTimes(1);
    } finally {
      rename.mockRestore();
    }
  });
});
