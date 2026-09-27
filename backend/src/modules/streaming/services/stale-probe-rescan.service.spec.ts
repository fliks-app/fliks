import { StaleProbeRescanService, needsReprobe } from './stale-probe-rescan.service';

describe('needsReprobe', () => {
  const current = {
    formatName: 'mov,mp4',
    formatStartSeconds: 0,
    video: [{ firstFrameSeconds: 0 }],
    audio: [{ startTimeSeconds: 0 }],
  };

  it('is false for a row carrying every current field', () => {
    expect(needsReprobe(current as never)).toBe(false);
  });

  it('is false with no video stream, nothing this backfill can fix', () => {
    expect(needsReprobe({ video: [] } as never)).toBe(false);
    expect(needsReprobe(null)).toBe(false);
  });

  it.each([
    ['formatName', { ...current, formatName: undefined }],
    ['formatStartSeconds', { ...current, formatStartSeconds: undefined }],
    ['firstFrameSeconds', { ...current, video: [{ firstFrameSeconds: undefined }] }],
    ['per-track audio start', { ...current, audio: [{ startTimeSeconds: undefined }] }],
  ])('is true when %s predates the current probe', (_label, si) => {
    expect(needsReprobe(si as never)).toBe(true);
  });
});

describe('StaleProbeRescanService', () => {
  const stale = {
    video: [{ firstFrameSeconds: 0 }],
    audio: [],
    formatStartSeconds: 0,
    // formatName absent: the stale field this row is missing.
  };
  const current = { ...stale, formatName: 'mov,mp4' };
  const freshProbe = { formatName: 'mov,mp4', video: [{ firstFrameSeconds: 0 }], audio: [] };

  const setup = (row: object | null = { streamInfo: stale }) => {
    const detectMediaFileInfo = jest.fn().mockResolvedValue(freshProbe);
    const files = {
      findOne: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new StaleProbeRescanService(
      { detectMediaFileInfo } as never,
      files as never,
    );
    return { svc, detectMediaFileInfo, files };
  };

  it('re-probes and saves a stale row', async () => {
    const { svc, detectMediaFileInfo, files } = setup();
    await svc.scheduleIfNeeded(3, '/media/a.mkv', stale as never);
    expect(detectMediaFileInfo).toHaveBeenCalledWith('/media/a.mkv');
    expect(files.update).toHaveBeenCalledWith(3, { streamInfo: freshProbe });
  });

  it('never probes a row whose fields are all current', async () => {
    const { svc, detectMediaFileInfo } = setup({ streamInfo: current });
    await svc.scheduleIfNeeded(3, '/media/a.mkv', current as never);
    expect(detectMediaFileInfo).not.toHaveBeenCalled();
  });

  it('dedupes concurrent calls for the same file into one probe', async () => {
    const { svc, detectMediaFileInfo } = setup();
    await Promise.all([
      svc.scheduleIfNeeded(3, '/media/a.mkv', stale as never),
      svc.scheduleIfNeeded(3, '/media/a.mkv', stale as never),
    ]);
    expect(detectMediaFileInfo).toHaveBeenCalledTimes(1);
  });

  it('carries over crop and the stored clock break, which a plain probe never returns', async () => {
    const withExtras = {
      ...stale,
      video: [{ firstFrameSeconds: 0, crop: '1920:800:0:140' }],
      timestampBreakSeconds: 12,
    };
    const { svc, files } = setup({ streamInfo: withExtras });
    await svc.scheduleIfNeeded(3, '/media/a.mkv', withExtras as never);
    expect(files.update).toHaveBeenCalledWith(3, {
      streamInfo: {
        ...freshProbe,
        video: [{ ...freshProbe.video[0], crop: '1920:800:0:140' }],
        timestampBreakSeconds: 12,
      },
    });
  });

  it('never throws when the probe fails', async () => {
    const files = { findOne: jest.fn(), update: jest.fn() };
    const svc = new StaleProbeRescanService(
      { detectMediaFileInfo: jest.fn().mockRejectedValue(new Error('boom')) } as never,
      files as never,
    );
    await expect(svc.scheduleIfNeeded(3, '/media/a.mkv', stale as never)).resolves.toBeUndefined();
    expect(files.update).not.toHaveBeenCalled();
  });
});
