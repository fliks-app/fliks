import 'reflect-metadata';
import { Readable } from 'stream';
import { LiveTvGuideService } from './livetv-guide.service';
import { LiveTvGuideChannel } from '../entities/livetv-guide-channel.entity';
import { liveTvGet } from '../livetv-http';

jest.mock('../livetv-http', () => {
  const actual = jest.requireActual('../livetv-http');
  return { ...actual, liveTvGet: jest.fn() };
});
const mockedLiveTvGet = liveTvGet as jest.Mock;

/** One guide channel id, matchable both by id and by display name. */
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="bbc1">
    <display-name>BBC One</display-name>
  </channel>
</tv>`;

/** Binary-mode stream, like the real axios response: `maybeGunzip`'s
 *  `read(2)` peek only works with byte chunks, not an object-mode iterable. */
function feedStream(): Readable {
  const s = new Readable();
  s.push(Buffer.from(FEED));
  s.push(null);
  return s;
}

function setup() {
  const guideSource = {
    id: 1,
    name: 'Guide',
    kind: 'xmltv' as const,
    url: 'http://guide.example/xmltv',
    source: null,
    etag: null,
    lastModified: null,
    timezoneOffsetMinutes: 0,
    language: null,
    programCount: 0,
  };
  const guideSourceRepo = {
    findOne: jest.fn().mockResolvedValue(guideSource),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const guideChannelRepo = {
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn((x: unknown) => x),
    save: jest.fn(async (rows: unknown) => rows),
  };
  const programRepo = { createQueryBuilder: jest.fn(), save: jest.fn() };
  const channelRepo = {
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: (manager: unknown) => unknown) =>
      cb({
        getRepository: (entity: unknown) =>
          entity === LiveTvGuideChannel ? guideChannelRepo : programRepo,
      }),
    ),
  };
  const settings = { get: jest.fn().mockResolvedValue(null) };

  const service = new LiveTvGuideService(
    guideSourceRepo as never,
    guideChannelRepo as never,
    channelRepo as never,
    programRepo as never,
    dataSource as never,
    settings as never,
    {} as never,
    {} as never,
  );

  return { service, channelRepo };
}

describe('LiveTvGuideService.syncGuideSource', () => {
  afterEach(() => jest.resetAllMocks());

  // Grouping by (guideChannelId, kind) instead of just guideChannelId: a shared
  // id with mixed match kinds must not fold into one UPDATE and lose a kind.
  it('keeps each channel its own match kind when two share a guide channel id', async () => {
    mockedLiveTvGet.mockResolvedValue({ status: 200, data: feedStream(), headers: {} });
    const { service, channelRepo } = setup();
    channelRepo.find.mockResolvedValue([
      { id: 1, name: 'Something else', guideChannelId: 'bbc1', guideMatchKind: null },
      { id: 2, name: 'BBC One', guideChannelId: null, guideMatchKind: null },
    ]);

    await service.syncGuideSource(1);

    expect(channelRepo.update).toHaveBeenCalledWith([1], {
      guideChannelId: 'bbc1',
      guideMatchKind: 'id',
    });
    expect(channelRepo.update).toHaveBeenCalledWith([2], {
      guideChannelId: 'bbc1',
      guideMatchKind: 'name',
    });
  });
});
