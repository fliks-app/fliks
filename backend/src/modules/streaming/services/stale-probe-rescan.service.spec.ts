import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StaleProbeRescanService, needsReprobe } from './stale-probe-rescan.service';

describe('needsReprobe', () => {
  const withVideo = { formatName: 'mov,mp4', video: [{ firstFrameSeconds: 0 }] };

  it('is false for a row carrying formatName', () => {
    expect(needsReprobe(withVideo as never)).toBe(false);
  });

  it('is false with no video stream, nothing this backfill can fix', () => {
    expect(needsReprobe({ video: [] } as never)).toBe(false);
    expect(needsReprobe(null)).toBe(false);
  });

  it('is true when formatName predates the current probe', () => {
    expect(needsReprobe({ video: [{ firstFrameSeconds: 0 }] } as never)).toBe(true);
  });

  it.each([
    ['formatStartSeconds', { ...withVideo, formatStartSeconds: undefined }],
    ['firstFrameSeconds', { ...withVideo, video: [{ firstFrameSeconds: undefined }] }],
    ['per-track audio start', { ...withVideo, audio: [{ startTimeSeconds: undefined }] }],
  ])('is false when only %s is missing — formatName alone decides staleness', (_label, si) => {
    expect(needsReprobe(si as never)).toBe(false);
  });
});

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
    await svc.scheduleIfNeeded(3, file, stale as never);
    expect(detectMediaFileInfo).toHaveBeenCalledWith(file);
    expect(files.update).toHaveBeenCalledWith(3, { streamInfo: freshProbe });
    expect(sourceScans.scheduleIfNeeded).toHaveBeenCalledWith(3, file, freshProbe);
  });

  it('never probes a row whose fields are all current', async () => {
    const current = { ...stale, formatName: 'mov,mp4' };
    const { svc, detectMediaFileInfo } = setup({ streamInfo: current });
    await svc.scheduleIfNeeded(3, file, current as never);
    expect(detectMediaFileInfo).not.toHaveBeenCalled();
  });

  it('dedupes concurrent calls for the same file into one probe', async () => {
    const { svc, detectMediaFileInfo } = setup();
    await Promise.all([
      svc.scheduleIfNeeded(3, file, stale as never),
      svc.scheduleIfNeeded(3, file, stale as never),
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
    await svc.scheduleIfNeeded(3, file, withExtras as never);
    expect(files.update).toHaveBeenCalledWith(3, {
      streamInfo: {
        ...freshProbe,
        video: [{ ...freshProbe.video[0], crop: '1920:800:0:140' }],
        timestampBreakSeconds: 12,
      },
    });
  });

  it('never saves a probe that resolved with an error — the real ffprobe behaviour on a timeout or a corrupt header', async () => {
    const broken = { video: [], audio: [], subtitles: [], error: 'ffprobe file info failed: timed out' };
    const { svc, files, sourceScans } = setup({ streamInfo: stale }, broken);
    await expect(svc.scheduleIfNeeded(3, file, stale as never)).resolves.toBeUndefined();
    expect(files.update).not.toHaveBeenCalled();
    expect(sourceScans.scheduleIfNeeded).not.toHaveBeenCalled();
  });

  it('never saves a probe that detected no streams at all', async () => {
    const broken = { video: [], audio: [], subtitles: [], formatName: 'mov,mp4', error: 'No streams detected' };
    const { svc, files } = setup({ streamInfo: stale }, broken);
    await svc.scheduleIfNeeded(3, file, stale as never);
    expect(files.update).not.toHaveBeenCalled();
  });

  it('never saves a probe that silently lost the video stream the old row had', async () => {
    const broken = { video: [], audio: [{ streamIndex: 1 }], subtitles: [], formatName: 'mov,mp4' };
    const { svc, files } = setup({ streamInfo: stale }, broken);
    await svc.scheduleIfNeeded(3, file, stale as never);
    expect(files.update).not.toHaveBeenCalled();
  });

  it('drops the result when the file changed size while it was re-probed', async () => {
    const { svc, files, detectMediaFileInfo } = setup();
    detectMediaFileInfo.mockImplementation(async () => {
      fs.writeFileSync(file, 'y'.repeat(500));
      return { formatName: 'mov,mp4', video: [{ firstFrameSeconds: 0 }], audio: [] };
    });
    await svc.scheduleIfNeeded(3, file, stale as never);
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
    await expect(svc.scheduleIfNeeded(3, file, stale as never)).resolves.toBeUndefined();
    expect(files.update).not.toHaveBeenCalled();
  });
});
