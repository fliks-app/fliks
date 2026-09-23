import { MarkersService } from './markers.service';

// `inFlight` is the only lock on season detection: holding an id past the run
// refuses every later call for that season, and nothing but a restart clears it.
describe('MarkersService runDetection in-flight lock', () => {
  function makeService(opts: { firstUpdateFails: boolean }) {
    const season = { id: 42, mediaId: 9, seasonNumber: 1, media: { title: 'Show' } };
    const seasonRepo = { findOne: jest.fn().mockResolvedValue(season) };
    let cmdId = 0;
    const commandRepo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn().mockImplementation(async (cmd: object) => ({
        ...cmd,
        id: ++cmdId,
      })),
      update: opts.firstUpdateFails
        ? jest
            .fn()
            .mockRejectedValueOnce(new Error('db down'))
            .mockResolvedValue(undefined)
        : jest.fn().mockResolvedValue(undefined),
    };
    const events = { emit: jest.fn() };
    const activityRegistry = { upsertRunning: jest.fn(), remove: jest.fn() };
    const detector = {
      detectSeasonIntros: jest.fn().mockResolvedValue({ introsDetected: 0 }),
      detectSeasonOutros: jest.fn().mockResolvedValue({ outrosDetected: 0 }),
    };
    const episodeRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      }),
    };
    const service = new MarkersService(
      {} as never,
      episodeRepo as never,
      seasonRepo as never,
      commandRepo as never,
      events as never,
      activityRegistry as never,
      {} as never,
      detector as never,
    );
    return { service };
  }

  it('lets a later detectSeason call through after the running-update rejects', async () => {
    const { service } = makeService({ firstUpdateFails: true });

    await service.detectSeason(42, 'manual');
    // Flush the fire-and-forget runDetection() rejection.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(service.detectSeason(42, 'manual')).resolves.toBeDefined();
  });
});
