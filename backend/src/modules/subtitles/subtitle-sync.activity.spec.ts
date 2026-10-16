const readFile = jest.fn(async () =>
  Buffer.from('1\n00:00:10,000 --> 00:00:12,000\nsync me\n'),
);
const writeFile = jest.fn(async () => undefined);
jest.mock('fs/promises', () => ({ readFile, writeFile }));

import { SubtitleSyncService } from './subtitle-sync.service';
import { SubtitleProviderType } from '../../common/enums';

// The queue lives in this process, so the activity registry is the only place a
// client can read it from.
describe('SubtitleSyncService queue visibility', () => {
  beforeEach(() => {
    readFile.mockClear();
    writeFile.mockClear();
  });

  it('registers the queued sync as running, then clears it on completion', async () => {
    const subtitle = {
      id: 1,
      mediaId: 1,
      mediaFileId: 1,
      language: 'fr',
      relativePath: 'movie.fr.srt',
      providerType: SubtitleProviderType.OPENSUBTITLES,
      media: { id: 1, title: 'Movie', type: 'movie' },
      episode: null,
    };
    const repo = {
      findOne: jest.fn().mockResolvedValue(subtitle),
      save: jest.fn(async (s: unknown) => s),
    };
    const mediaRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 1, path: '/medias/movie', title: 'Movie' }),
    };
    const mediaFileRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 1,
        relativePath: 'movie.mkv',
        streamInfo: { video: [], audio: [], subtitles: [] },
      }),
    };
    const activityRegistry = {
      upsertPending: jest.fn(),
      upsertRunning: jest.fn(),
      remove: jest.fn(),
    };
    const service = new SubtitleSyncService(
      repo as never,
      mediaRepo as never,
      mediaFileRepo as never,
      { dispatch: jest.fn() } as never,
      {
        runJob: jest.fn().mockResolvedValue({
          type: 'SubtitleSync',
          subtitle: { format: 'srt', text: '1\n00:00:01,000 --> 00:00:02,000\nok\n' },
        }),
      } as never,
      { emit: jest.fn() } as never,
      activityRegistry as never,
    );

    await service.enqueueSyncSubtitle(1);

    expect(activityRegistry.upsertPending).toHaveBeenCalledWith(
      'SubtitleSync:1',
      'SubtitleSync',
      expect.objectContaining({ title: 'Movie' }),
    );

    // Flush the fire-and-forget processQueue() run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(activityRegistry.upsertRunning).toHaveBeenCalledWith(
      'SubtitleSync:1',
      'SubtitleSync',
      expect.objectContaining({ title: 'Movie' }),
    );
    expect(activityRegistry.remove).toHaveBeenCalledWith('SubtitleSync:1');
  });
});
