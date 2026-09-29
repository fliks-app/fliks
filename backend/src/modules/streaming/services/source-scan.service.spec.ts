import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SourceScanService, sourceVersion } from './source-scan.service';
import * as sourceScan from '../transcoding/source-scan';

describe('SourceScanService', () => {
  const ts = { formatName: 'mpegts', video: [{ streamIndex: 0, codec: 'h264' }], audio: [], subtitles: [] };
  const result = { keyframes: [{ pts: 1, dts: 0.9 }], end: 40, breakSeconds: 32.8, audioConfigChanges: {} };
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-svc-'));
    file = path.join(dir, 'a.ts');
    fs.writeFileSync(file, 'x'.repeat(100));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const setsBreak = (files: { update: jest.Mock }, value: string) => {
    expect(files.update).toHaveBeenCalledTimes(1);
    const [id, { streamInfo }] = files.update.mock.calls[0];
    expect(id).toBe(3);
    expect(streamInfo()).toBe(
      `jsonb_set("streamInfo", '{timestampBreakSeconds}', '${value}'::jsonb)`,
    );
  };

  const setup = (row: object | null = null) => {
    const scans = {
      findOne: jest.fn().mockResolvedValue(row),
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    const files = { update: jest.fn().mockResolvedValue(undefined) };
    return { scans, files, svc: new SourceScanService(scans as never, files as never) };
  };

  it('holds a stored scan only while the file keeps its size and mtime', async () => {
    const st = fs.statSync(file);
    const { svc } = setup({ size: st.size, mtimeMs: st.mtimeMs, scan: result });
    expect(await svc.lookup(3, file)).toEqual({ scan: result, version: sourceVersion(st) });
    fs.writeFileSync(file, 'y'.repeat(200));
    const now = fs.statSync(file);
    expect(await svc.lookup(3, file)).toEqual({ scan: null, version: sourceVersion(now) });
  });

  it('falls back to no scan instead of rejecting when the scan row lookup fails', async () => {
    const st = fs.statSync(file);
    const { scans, svc } = setup();
    scans.findOne.mockRejectedValue(new Error('connection terminated'));
    await expect(svc.lookup(3, file)).resolves.toEqual({ scan: null, version: sourceVersion(st) });
  });

  it('scans once for concurrent callers, stores it, and the clock break on the row', async () => {
    const scan = jest.spyOn(sourceScan, 'scanSource').mockResolvedValue(result);
    const { scans, files, svc } = setup();
    await Promise.all([
      svc.scheduleIfNeeded(3, file, ts as never),
      svc.scheduleIfNeeded(3, file, ts as never),
    ]);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0][2]).toEqual({ background: true });
    const st = fs.statSync(file);
    expect(scans.upsert).toHaveBeenCalledWith(
      { mediaFileId: 3, size: st.size, mtimeMs: st.mtimeMs, scan: result },
      ['mediaFileId'],
    );
    setsBreak(files, '32.8');
  });

  it('skips a file scanned at its current version, and one without video', async () => {
    const scan = jest.spyOn(sourceScan, 'scanSource');
    const st = fs.statSync(file);
    const { svc } = setup({ size: st.size, mtimeMs: st.mtimeMs, scan: result });
    await svc.scheduleIfNeeded(3, file, ts as never);
    await svc.scheduleIfNeeded(3, file, { ...ts, video: [] } as never);
    expect(scan).not.toHaveBeenCalled();
  });

  it('restores a dropped clock break in the caller streamInfo and the row', async () => {
    const st = fs.statSync(file);
    const { files, svc } = setup({ size: st.size, mtimeMs: st.mtimeMs, scan: result });
    const si = { ...ts } as { timestampBreakSeconds?: number };
    await svc.lookup(3, file, si as never);
    expect(si.timestampBreakSeconds).toBe(32.8);
    setsBreak(files, '32.8');
  });

  it('writes nothing when the break already matches or no streamInfo is given', async () => {
    const st = fs.statSync(file);
    const { files, svc } = setup({ size: st.size, mtimeMs: st.mtimeMs, scan: result });
    await svc.lookup(3, file, { ...ts, timestampBreakSeconds: 32.8 } as never);
    await svc.lookup(3, file);
    expect(files.update).not.toHaveBeenCalled();
  });

  it('drops a scan of a file that changed under it', async () => {
    jest.spyOn(sourceScan, 'scanSource').mockImplementation(async () => {
      fs.writeFileSync(file, 'z'.repeat(300));
      return result;
    });
    const { scans, svc } = setup();
    await svc.scheduleIfNeeded(3, file, ts as never);
    expect(scans.upsert).not.toHaveBeenCalled();
  });
});
