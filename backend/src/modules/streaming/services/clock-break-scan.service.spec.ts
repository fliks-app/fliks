import { ClockBreakScanService } from './clock-break-scan.service';
import * as packets from '../../subtitles/video-packets';

describe('ClockBreakScanService', () => {
  const ts = { formatName: 'mpegts', video: [{ streamIndex: 0, codec: 'h264' }], audio: [], subtitles: [] };

  const setup = (streamInfo: object) => {
    const files = {
      findOne: jest.fn().mockResolvedValue({ id: 3, streamInfo }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    return { files, svc: new ClockBreakScanService(files as never) };
  };

  afterEach(() => jest.restoreAllMocks());

  it('stores the break, or null for none, once for concurrent callers', async () => {
    const scan = jest
      .spyOn(packets, 'videoPackets')
      .mockResolvedValue({ keyframes: [], end: 40, breakSeconds: 32.8 });
    const { files, svc } = setup(ts);
    await Promise.all([
      svc.scheduleIfNeeded(3, '/m/a.ts', ts as never),
      svc.scheduleIfNeeded(3, '/m/a.ts', ts as never),
    ]);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0][2]).toEqual({ mpegTs: true, background: true });
    expect(files.update).toHaveBeenCalledWith(3, {
      streamInfo: { ...ts, timestampBreakSeconds: 32.8 },
    });

    scan.mockResolvedValue({ keyframes: [], end: 40 });
    await svc.scheduleIfNeeded(3, '/m/a.ts', ts as never);
    expect(files.update).toHaveBeenLastCalledWith(3, {
      streamInfo: { ...ts, timestampBreakSeconds: null },
    });
  });

  it('skips a scanned file and anything not MPEG-TS', async () => {
    const scan = jest.spyOn(packets, 'videoPackets');
    const { svc } = setup(ts);
    await svc.scheduleIfNeeded(3, '/m/a.ts', { ...ts, timestampBreakSeconds: null } as never);
    await svc.scheduleIfNeeded(3, '/m/a.mkv', { ...ts, formatName: 'matroska,webm' } as never);
    expect(scan).not.toHaveBeenCalled();
  });
});
