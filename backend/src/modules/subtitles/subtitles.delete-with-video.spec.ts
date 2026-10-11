import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SubtitlesService } from './subtitles.service';
import { SubtitleProviderType } from '../../common/enums';

describe('SubtitlesService.deleteSubtitleFilesOnDisk', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fliks-subtitle-delete-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("unlinks the video's own sidecars, but not embedded tracks or a file another video lists", async () => {
    for (const f of ['a.fr.srt', 'a.en.srt', 'shared.srt']) writeFileSync(join(dir, f), '');
    const service = Object.create(SubtitlesService.prototype) as SubtitlesService;
    const wired = service as unknown as Record<string, unknown>;
    wired.repo = {
      find: jest.fn().mockResolvedValue([
        { mediaFileId: 10, relativePath: 'a.fr.srt', providerType: SubtitleProviderType.DISK },
        { mediaFileId: 10, relativePath: 'a.en.srt', providerType: SubtitleProviderType.TRANSLATED },
        { mediaFileId: 10, relativePath: 'shared.srt', providerType: SubtitleProviderType.DISK },
        { mediaFileId: 10, relativePath: null, providerType: SubtitleProviderType.EMBEDDED },
        { mediaFileId: 11, relativePath: 'shared.srt', providerType: SubtitleProviderType.DISK },
      ]),
    };
    wired.mediaRepo = { findOne: jest.fn().mockResolvedValue({ id: 1, path: dir }) };
    wired.logger = { log: jest.fn(), warn: jest.fn() };

    await service.deleteSubtitleFilesOnDisk(1, 10);

    expect(existsSync(join(dir, 'a.fr.srt'))).toBe(false);
    expect(existsSync(join(dir, 'a.en.srt'))).toBe(false);
    expect(existsSync(join(dir, 'shared.srt'))).toBe(true);
  });
});

describe('SubtitlesService.carryOver', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fliks-subtitle-carry-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('renames sidecars after the new video, unless the new release ships that name', async () => {
    for (const f of ['Old.fr.forced.srt', 'Old.en.srt', 'New.en.srt']) writeFileSync(join(dir, f), f);
    const subs = [
      { id: 1, relativePath: 'Old.fr.forced.srt', providerType: SubtitleProviderType.OPENSUBTITLES, hashMatched: true },
      { id: 2, relativePath: 'Old.en.srt', providerType: SubtitleProviderType.DISK },
      { id: 3, relativePath: null, providerType: SubtitleProviderType.EMBEDDED },
    ];
    const service = Object.create(SubtitlesService.prototype) as SubtitlesService;
    const wired = service as unknown as Record<string, unknown>;
    wired.repo = { find: jest.fn().mockResolvedValue(subs), save: jest.fn() };
    wired.mediaRepo = { findOne: jest.fn().mockResolvedValue({ id: 1, path: dir }) };
    wired.mediaFileRepo = { findOne: jest.fn().mockResolvedValue({ id: 10, relativePath: 'Old.mkv' }) };
    wired.logger = { log: jest.fn(), warn: jest.fn() };

    const moved = await service.carryOver(1, 10, { id: 20, relativePath: 'New.mkv' } as never);

    expect(moved).toEqual([1]);
    expect(existsSync(join(dir, 'New.fr.forced.srt'))).toBe(true);
    expect(subs[0]).toMatchObject({ relativePath: 'New.fr.forced.srt', mediaFile: { id: 20 }, hashMatched: false });
    expect(existsSync(join(dir, 'Old.en.srt'))).toBe(true);
  });
});
