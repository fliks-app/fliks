const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: execFileMock }));

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
    const service = new SubtitleSyncService(
      { findOne: jest.fn().mockResolvedValue(subtitle), save } as never,
      { findOne: jest.fn().mockResolvedValue({ id: 1, path: '/medias/movie' }) } as never,
      { findOne: jest.fn().mockResolvedValue({ id: 1, relativePath: 'movie.mkv' }) } as never,
      { dispatch: jest.fn() } as never,
      { detectStreams: jest.fn().mockResolvedValue([]) } as never,
      { emit: jest.fn() } as never,
      { dispatch: jest.fn() } as never,
    );
    return { service, subtitle, save };
  };

  beforeEach(() => {
    execFileMock.mockReset();
    // promisify hands the callback last; every tool call fails.
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: Error) => void;
      cb(Object.assign(new Error('exit 1'), { stderr: 'could not parse subtitle file' }));
    });
  });

  it('records the flag and the cause on the row, leaving the status alone', async () => {
    const { service, subtitle, save } = build({ status: SubtitleStatus.DOWNLOADED });

    await expect(service.syncSubtitle(1)).rejects.toThrow('Sync failed');

    expect(save).toHaveBeenCalled();
    expect(subtitle.syncFailed).toBe(true);
    expect(subtitle.status).toBe(SubtitleStatus.DOWNLOADED);
    expect(subtitle.errorMessage).toContain('could not parse subtitle file');
  });

  it('clears a previous failure when a later attempt succeeds', async () => {
    const { service, subtitle } = build({
      status: SubtitleStatus.DOWNLOADED,
      syncFailed: true,
      errorMessage: 'the previous run',
    });
    execFileMock.mockImplementation((...args: unknown[]) => {
      (args[args.length - 1] as (e: null, out: string, err: string) => void)(null, '', '');
    });

    await service.syncSubtitle(1);

    expect(subtitle.syncFailed).toBe(false);
    expect(subtitle.errorMessage).toBeNull();
    expect(subtitle.status).toBe(SubtitleStatus.SYNCED);
    expect(subtitle.synced).toBe(true);
  });
});
