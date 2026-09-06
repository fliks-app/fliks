import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SubtitlesService } from './subtitles.service';

/**
 * `discoverExternalSubtitles` is only exercised here for the root-level-movie
 * guard: a bare prototype instance with `mediaRepo` and `repo` wired is
 * enough since no other collaborator is touched on this path.
 */
function buildHarness() {
  const service = Object.create(SubtitlesService.prototype) as SubtitlesService;
  const mediaRepo = { findOne: jest.fn() };
  const repo = { find: jest.fn().mockResolvedValue([]), save: jest.fn() };
  const wired = service as unknown as Record<string, unknown>;
  wired.mediaRepo = mediaRepo;
  wired.repo = repo;
  wired.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, mediaRepo, repo };
}

describe('SubtitlesService.discoverExternalSubtitles - a movie with no folder of its own', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fliks-subtitle-discover-root-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('attaches a subtitle whose name matches its own file, ignoring a sibling root movie sidecar', async () => {
    const { service, mediaRepo, repo } = buildHarness();
    writeFileSync(join(dir, 'sample.movie.2001.mkv'), '');
    writeFileSync(join(dir, 'sample.movie.2001.en.srt'), '');
    // A sidecar for a different root-level movie, sitting right next to it.
    writeFileSync(join(dir, 'stray-orphan.srt'), '');
    mediaRepo.findOne.mockResolvedValue({
      id: 1,
      folderName: '',
      path: dir,
      files: [{ id: 1, relativePath: 'sample.movie.2001.mkv', episodeId: null }],
    });

    const discovered = await service.discoverExternalSubtitles(1);

    expect(discovered).toBe(1);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'sample.movie.2001.en.srt' }),
    );
  });
});
