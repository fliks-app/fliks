import { SubtitlesService } from './subtitles.service';

/**
 * `discoverExternalSubtitles` is only exercised here for the root-level-movie
 * guard: a bare prototype instance with just `mediaRepo` wired is enough
 * since the guard returns before any other collaborator is touched.
 */
function buildHarness() {
  const service = Object.create(SubtitlesService.prototype) as SubtitlesService;
  const mediaRepo = { findOne: jest.fn() };
  (service as unknown as Record<string, unknown>).mediaRepo = mediaRepo;
  return { service, mediaRepo };
}

describe('SubtitlesService.discoverExternalSubtitles — a movie with no folder of its own', () => {
  it('never scans the shared library root: a sibling root-level movie could share it', async () => {
    const { service, mediaRepo } = buildHarness();
    mediaRepo.findOne.mockResolvedValue({
      id: 1,
      folderName: '',
      path: '/library/movies',
      files: [{ id: 1, relativePath: 'Quiet.Harbor.2020.mkv' }],
    });

    const discovered = await service.discoverExternalSubtitles(1);

    expect(discovered).toBe(0);
  });
});
