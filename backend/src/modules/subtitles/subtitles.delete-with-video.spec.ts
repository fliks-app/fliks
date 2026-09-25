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
