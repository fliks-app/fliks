const readFile = jest.fn(async () =>
  Buffer.from('1\n00:00:10,000 --> 00:00:12,000\nsync me\n'),
);
const writeFile = jest.fn(async () => undefined);
jest.mock('fs/promises', () => ({ readFile, writeFile }));

import { SubtitleSyncService } from './subtitle-sync.service';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';

/** The sync outcome is an axis of its own: a failure has to survive the throw
 *  without touching the status that decides whether the language is covered. */
describe('SubtitleSyncService — a failed sync', () => {
  const build = (row: Partial<SubtitleFile>) => {
    const subtitle: Partial<SubtitleFile> = {
      id: 1,
      mediaId: 1,
      mediaFileId: 1,
      language: 'fr',
      relativePath: 'movie.fr.srt',
      providerType: SubtitleProviderType.OPENSUBTITLES,
      ...row,
    };
    const save = jest.fn(async (s: unknown) => s);
    const runJob = jest.fn();
    const service = new SubtitleSyncService(
      { findOne: jest.fn().mockResolvedValue(subtitle), save } as never,
      { findOne: jest.fn().mockResolvedValue({ id: 1, path: '/medias/movie' }) } as never,
      {
        findOne: jest.fn().mockResolvedValue({
          id: 1,
          relativePath: 'movie.mkv',
          streamInfo: { video: [], audio: [], subtitles: [] },
        }),
      } as never,
      { dispatch: jest.fn() } as never,
      { runJob } as never,
      { emit: jest.fn() } as never,
      { upsertPending: jest.fn(), upsertRunning: jest.fn(), remove: jest.fn() } as never,
    );
    return { service, subtitle, save, runJob };
  };

  beforeEach(() => {
    readFile.mockClear();
    writeFile.mockClear();
  });

  it('records the flag and the cause on the row, leaving the status alone', async () => {
    const { service, subtitle, save, runJob } = build({ status: SubtitleStatus.DOWNLOADED });
    runJob.mockRejectedValue(new Error('could not parse subtitle file'));

    await expect(service.syncSubtitle(1)).rejects.toThrow('Sync failed');

    expect(save).toHaveBeenCalled();
    expect(subtitle.syncFailed).toBe(true);
    expect(subtitle.status).toBe(SubtitleStatus.DOWNLOADED);
    expect(subtitle.errorMessage).toContain('could not parse subtitle file');
  });

  it('clears a previous failure when a later attempt succeeds', async () => {
    const { service, subtitle, runJob } = build({
      status: SubtitleStatus.DOWNLOADED,
      syncFailed: true,
      errorMessage: 'the previous run',
    });
    runJob.mockResolvedValue({
      type: 'SubtitleSync',
      subtitle: { format: 'srt', text: '1\n00:00:01,000 --> 00:00:02,000\nok\n' },
    });

    await service.syncSubtitle(1);

    expect(subtitle.syncFailed).toBe(false);
    expect(subtitle.errorMessage).toBeNull();
    expect(subtitle.status).toBe(SubtitleStatus.SYNCED);
    expect(subtitle.synced).toBe(true);
    expect(writeFile).toHaveBeenCalled();
  });
});
