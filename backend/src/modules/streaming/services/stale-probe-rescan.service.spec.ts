import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StaleProbeRescanService } from './stale-probe-rescan.service';

describe('StaleProbeRescanService', () => {
  const stale = {
    video: [{ firstFrameSeconds: 0 }],
    audio: [],
    formatStartSeconds: 0,
    // formatName absent: the stale field this row is missing.
  };
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-probe-'));
    file = path.join(dir, 'a.mkv');
    fs.writeFileSync(file, 'x'.repeat(100));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const setup = (
    row: object | null = { streamInfo: stale },
    freshProbe: object = { formatName: 'mov,mp4', video: [{ firstFrameSeconds: 0 }], audio: [] },
  ) => {
    const detectMediaFileInfo = jest.fn().mockResolvedValue(freshProbe);
    const files = {
      findOne: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const sourceScans = { scheduleIfNeeded: jest.fn().mockResolvedValue(undefined) };
    const svc = new StaleProbeRescanService(
      { detectMediaFileInfo } as never,
      files as never,
      sourceScans as never,
    );
    return { svc, detectMediaFileInfo, files, sourceScans };
  };

  it('re-probes and saves a stale row, then chains the keyframe scan on the fresh row', async () => {
    const freshProbe = { formatName: 'mov,mp4', video: [{ firstFrameSeconds: 0 }], audio: [] };
    const { svc, detectMediaFileInfo, files, sourceScans } = setup({ streamInfo: stale }, freshProbe);
    await svc.schedule(3, file);
    expect(detectMediaFileInfo).toHaveBeenCalledWith(file);
    expect(files.update).toHaveBeenCalledWith(3, { streamInfo: freshProbe });
    expect(sourceScans.scheduleIfNeeded).toHaveBeenCalledWith(3, file, freshProbe);
  });

  it('dedupes concurrent calls for the same file into one probe', async () => {
    const { svc, detectMediaFileInfo } = setup();
    await Promise.all([
      svc.schedule(3, file),
      svc.schedule(3, file),
    ]);
    expect(detectMediaFileInfo).toHaveBeenCalledTimes(1);
  });

  it('carries over crop and the stored clock break, which a plain probe never returns', async () => {
    const withExtras = {
      ...stale,
      video: [{ firstFrameSeconds: 0, crop: '1920:800:0:140' }],
      timestampBreakSeconds: 12,
    };
    const freshProbe = { formatName: 'mov,mp4', video: [{ firstFrameSeconds: 0 }], audio: [] };
    const { svc, files } = setup({ streamInfo: withExtras }, freshProbe);
    await svc.schedule(3, file);
    expect(files.update).toHaveBeenCalledWith(3, {
      streamInfo: {
        ...freshProbe,
        video: [{ ...freshProbe.video[0], crop: '1920:800:0:140' }],
        timestampBreakSeconds: 12,
      },
    });
  });

  it('never saves a probe that resolved with an error, the real ffprobe behaviour on a timeout or a corrupt header, but still chains the scan on the existing row', async () => {
    const broken = { video: [], audio: [], subtitles: [], error: 'ffprobe file info failed: timed out' };
    const { svc, files, sourceScans } = setup({ streamInfo: stale }, broken);
    await expect(svc.schedule(3, file)).resolves.toBeUndefined();
    expect(files.update).not.toHaveBeenCalled();
    expect(sourceScans.scheduleIfNeeded).toHaveBeenCalledWith(3, file, stale);
  });

  it('remembers a rejected re-probe and never retries it, even on a later play', async () => {
    const broken = { video: [], audio: [], subtitles: [], error: 'ffprobe file info failed: timed out' };
    const { svc, detectMediaFileInfo } = setup({ streamInfo: stale }, broken);
    await svc.schedule(3, file);
    await svc.schedule(3, file);
    expect(detectMediaFileInfo).toHaveBeenCalledTimes(1);
  });

  it('remembers a re-probe that threw and never retries it', async () => {
    const detectMediaFileInfo = jest.fn().mockRejectedValue(new Error('boom'));
    const svc = new StaleProbeRescanService(
      { detectMediaFileInfo } as never,
      { findOne: jest.fn(), update: jest.fn() } as never,
      { scheduleIfNeeded: jest.fn() } as never,
    );
    await svc.schedule(3, file);
    await svc.schedule(3, file);
    expect(detectMediaFileInfo).toHaveBeenCalledTimes(1);
  });

  it('still chains the keyframe scan on the existing row when the re-probe itself throws', async () => {
    const detectMediaFileInfo = jest.fn().mockRejectedValue(new Error('boom'));
    const files = {
      findOne: jest.fn().mockResolvedValue({ streamInfo: stale }),
      update: jest.fn(),
    };
    const sourceScans = { scheduleIfNeeded: jest.fn().mockResolvedValue(undefined) };
    const svc = new StaleProbeRescanService(
      { detectMediaFileInfo } as never,
      files as never,
      sourceScans as never,
    );
    await svc.schedule(3, file);
    expect(sourceScans.scheduleIfNeeded).toHaveBeenCalledWith(3, file, stale);
  });

  it('never saves a probe that detected no streams at all', async () => {
    const broken = { video: [], audio: [], subtitles: [], formatName: 'mov,mp4', error: 'No streams detected' };
    const { svc, files } = setup({ streamInfo: stale }, broken);
    await svc.schedule(3, file);
    expect(files.update).not.toHaveBeenCalled();
  });

  it('never saves a probe that silently lost the video stream the old row had', async () => {
    const broken = { video: [], audio: [{ streamIndex: 1 }], subtitles: [], formatName: 'mov,mp4' };
    const { svc, files } = setup({ streamInfo: stale }, broken);
    await svc.schedule(3, file);
    expect(files.update).not.toHaveBeenCalled();
  });

  it('drops the result when the file changed size while it was re-probed', async () => {
    const { svc, files, detectMediaFileInfo } = setup();
    detectMediaFileInfo.mockImplementation(async () => {
      fs.writeFileSync(file, 'y'.repeat(500));
      return { formatName: 'mov,mp4', video: [{ firstFrameSeconds: 0 }], audio: [] };
    });
    await svc.schedule(3, file);
    expect(files.findOne).not.toHaveBeenCalled();
    expect(files.update).not.toHaveBeenCalled();
  });

  it('never throws when a step in the pipeline rejects (e.g. a DB hiccup)', async () => {
    const files = { findOne: jest.fn().mockRejectedValue(new Error('db down')), update: jest.fn() };
    const sourceScans = { scheduleIfNeeded: jest.fn() };
    const svc = new StaleProbeRescanService(
      {
        detectMediaFileInfo: jest
          .fn()
          .mockResolvedValue({ formatName: 'mov,mp4', video: [{ firstFrameSeconds: 0 }], audio: [] }),
      } as never,
      files as never,
      sourceScans as never,
    );
    await expect(svc.schedule(3, file)).resolves.toBeUndefined();
    expect(files.update).not.toHaveBeenCalled();
  });
});
