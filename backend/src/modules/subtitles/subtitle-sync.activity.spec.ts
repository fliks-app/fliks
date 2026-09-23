const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: execFileMock }));

import { SubtitleSyncService } from './subtitle-sync.service';
import { SubtitleProviderType } from '../../common/enums';

// The queue lives in this process, so the activity registry is the only place a
// client can read it from.
describe('SubtitleSyncService queue visibility', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: null, out: string, err: string) => void;
      cb(null, '', '');
    });
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
      findOne: jest.fn().mockResolvedValue({ id: 1, relativePath: 'movie.mkv' }),
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
      { detectStreams: jest.fn().mockResolvedValue([]) } as never,
      { emit: jest.fn() } as never,
      activityRegistry as never,
      { dispatch: jest.fn() } as never,
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
