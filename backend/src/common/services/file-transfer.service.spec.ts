import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FileTransferService } from './file-transfer.service';

describe('FileTransferService atomic transfer', () => {
  let service: FileTransferService;
  let tmpRoot: string;
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    service = new FileTransferService({} as never);
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fts-spec-'));
    srcDir = path.join(tmpRoot, 'src');
    destDir = path.join(tmpRoot, 'dest');
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(destDir, { recursive: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('copy: lands the complete content and leaves no temp file behind', async () => {
    const src = path.join(srcDir, 'movie.mp4');
    const dest = path.join(destDir, 'movie.mp4');
    await fsp.writeFile(src, 'complete-content');

    await service.transferFile(src, dest, 'copy');

    expect(await fsp.readFile(dest, 'utf8')).toBe('complete-content');
    expect(fs.readdirSync(destDir)).toEqual(['movie.mp4']);
  });

  it('copy: a destination basename at the filesystem limit still transfers', async () => {
    const longBase = `${'x'.repeat(251)}.mp4`;
    const src = path.join(srcDir, 'movie.mp4');
    const dest = path.join(destDir, longBase);
    await fsp.writeFile(src, 'complete-content');

    await service.transferFile(src, dest, 'copy');

    expect(await fsp.readFile(dest, 'utf8')).toBe('complete-content');
  });

  it('copy: an overwrite keeps the destination mode', async () => {
    const src = path.join(srcDir, 'movie.mp4');
    const dest = path.join(destDir, 'movie.mp4');
    await fsp.writeFile(src, 'new-content');
    await fsp.writeFile(dest, 'old-content');
    await fsp.chmod(dest, 0o640);

    await service.transferFile(src, dest, 'copy');

    expect(await fsp.readFile(dest, 'utf8')).toBe('new-content');
    expect((await fsp.stat(dest)).mode & 0o777).toBe(0o640);
  });

  it('copy: an interrupted copy leaves no file at the destination', async () => {
    const src = path.join(srcDir, 'movie.mp4');
    const dest = path.join(destDir, 'movie.mp4');
    await fsp.writeFile(src, 'complete-content');
    // Simulate a copy that dies mid-write: writes partial bytes to
    // whichever path it was given, then throws.
    jest
      .spyOn(fs.promises, 'copyFile')
      .mockImplementationOnce(async (_s, d) => {
        await fsp.writeFile(d as string, 'PARTIAL');
        throw new Error('disk full');
      });

    await expect(service.transferFile(src, dest, 'copy')).rejects.toThrow(
      'disk full',
    );

    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.readdirSync(destDir)).toEqual([]);
  });

  it('companions: keeps every trailing flag, not just the first', async () => {
    for (const name of ['Old.en.hi.forced.srt', 'Old.fr.srt', 'Old.mkv']) {
      await fsp.writeFile(path.join(srcDir, name), 'x');
    }

    await service.transferCompanions({
      srcDir,
      destDir,
      sourceBaseName: 'Old',
      newBaseName: 'New',
      method: 'copy',
      allowedExts: new Set(['.srt']),
    });

    // ".hi" alone would be re-parsed as Hindi on the next library rescan
    const landed = (await fsp.readdir(destDir)).sort();
    expect(landed).toEqual(['New.en.hi.forced.srt', 'New.fr.srt']);
  });

  it('move (cross-device fallback): lands complete content, no temp file, source removed', async () => {
    const src = path.join(srcDir, 'movie.mp4');
    const dest = path.join(destDir, 'movie.mp4');
    await fsp.writeFile(src, 'complete-content');
    const exdev = Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(exdev);

    await service.transferFile(src, dest, 'move');

    expect(await fsp.readFile(dest, 'utf8')).toBe('complete-content');
    expect(fs.readdirSync(destDir)).toEqual(['movie.mp4']);
    expect(fs.existsSync(src)).toBe(false);
  });

  it('move (cross-device fallback): an interrupted copy leaves no file at the destination', async () => {
    const src = path.join(srcDir, 'movie.mp4');
    const dest = path.join(destDir, 'movie.mp4');
    await fsp.writeFile(src, 'complete-content');
    const exdev = Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(exdev);
    jest
      .spyOn(fs.promises, 'copyFile')
      .mockImplementationOnce(async (_s, d) => {
        await fsp.writeFile(d as string, 'PARTIAL');
        throw new Error('disk full');
      });

    await expect(service.transferFile(src, dest, 'move')).rejects.toThrow(
      'disk full',
    );

    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.readdirSync(destDir)).toEqual([]);
    expect(fs.existsSync(src)).toBe(true);
  });
});
