import { ScanBackfillService } from './scan-backfill.service';
import * as ffmpegSlots from '../../../common/utils/ffmpeg-slots';

jest.mock('../../../common/utils/ffmpeg-slots', () => ({
  freeFfmpegSlots: jest.fn(),
}));

describe('ScanBackfillService.tick', () => {
  const freeSlots = ffmpegSlots.freeFfmpegSlots as jest.Mock;

  const setup = (opts: {
    liveSessions?: number;
    pendingIds?: number[];
    resolveFile?: jest.Mock;
  } = {}) => {
    freeSlots.mockReturnValue(2);
    const files = { query: jest.fn().mockResolvedValue((opts.pendingIds ?? []).map((id) => ({ id }))) };
    const streamingService = {
      resolveFile:
        opts.resolveFile ??
        jest.fn().mockResolvedValue({
          absolutePath: '/m/a.mkv',
          mediaFile: { streamInfo: { video: [{ codec: 'hevc' }] } },
        }),
    };
    const sourceScans = { scheduleIfNeeded: jest.fn().mockResolvedValue(undefined) };
    const liveSessions = { size: jest.fn().mockReturnValue(opts.liveSessions ?? 0) };
    const svc = new ScanBackfillService(
      files as never,
      streamingService as never,
      sourceScans as never,
      liveSessions as never,
    );
    return { svc, files, streamingService, sourceScans, liveSessions };
  };

  afterEach(() => jest.clearAllMocks());

  it('scans the oldest pending file when idle with slots to spare', async () => {
    const { svc, sourceScans } = setup({ pendingIds: [7, 9] });
    await svc.tick();
    expect(sourceScans.scheduleIfNeeded).toHaveBeenCalledWith(
      7,
      '/m/a.mkv',
      { video: [{ codec: 'hevc' }] },
    );
  });

  it('yields when a playback session is active', async () => {
    const { svc, sourceScans } = setup({ pendingIds: [7], liveSessions: 1 });
    await svc.tick();
    expect(sourceScans.scheduleIfNeeded).not.toHaveBeenCalled();
  });

  it('skips starting a scan when it would leave no spare ffmpeg slot', async () => {
    const { svc, sourceScans } = setup({ pendingIds: [7] });
    freeSlots.mockReturnValue(1);
    await svc.tick();
    expect(sourceScans.scheduleIfNeeded).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing is pending', async () => {
    const { svc, streamingService } = setup({ pendingIds: [] });
    await svc.tick();
    expect(streamingService.resolveFile).not.toHaveBeenCalled();
  });

  it('never runs two scans at once, even if a tick fires before the last resolves', async () => {
    let releaseScan!: () => void;
    const sourceScansGate = new Promise<void>((r) => (releaseScan = r));
    const { svc, sourceScans, streamingService } = setup({ pendingIds: [7] });
    sourceScans.scheduleIfNeeded.mockImplementation(() => sourceScansGate);

    const first = svc.tick();
    const second = svc.tick(); // fires while `first` is still awaiting the scan
    releaseScan();
    await Promise.all([first, second]);

    expect(streamingService.resolveFile).toHaveBeenCalledTimes(1);
  });

  it('skips a file that fails to resolve instead of retrying it forever', async () => {
    const resolveFile = jest.fn().mockRejectedValue(new Error('gone'));
    const { svc, sourceScans } = setup({ pendingIds: [7], resolveFile });
    await svc.tick();
    expect(sourceScans.scheduleIfNeeded).not.toHaveBeenCalled();

    // Same pending id resurfaces from the DB (nothing scanned it), but the
    // service already knows it's broken and must not retry it in-process.
    resolveFile.mockClear();
    await svc.tick();
    expect(resolveFile).not.toHaveBeenCalled();
  });
});
