import { MediaMutationService } from './media-mutation.service';
import { Season } from '../entities/season.entity';

/**
 * Records the chainable `.update().set().where().execute()` calls a TypeORM
 * query builder receives so a test can assert which bulk UPDATEs were issued.
 */
interface QueryBuilderRecorder {
  set?: Record<string, unknown>;
  where?: { clause: string; params?: Record<string, unknown> };
  executed: boolean;
}

function fakeRepoWithBuilder(recorders: QueryBuilderRecorder[]) {
  return {
    createQueryBuilder: jest.fn(() => {
      const rec: QueryBuilderRecorder = { executed: false };
      recorders.push(rec);
      const builder = {
        update: () => builder,
        set: (v: Record<string, unknown>) => {
          rec.set = v;
          return builder;
        },
        where: (clause: string, params?: Record<string, unknown>) => {
          rec.where = { clause, params };
          return builder;
        },
        whereInIds: () => builder,
        execute: () => {
          rec.executed = true;
          return Promise.resolve({ affected: 1 });
        },
      };
      return builder;
    }),
  };
}

describe('MediaMutationService monitoring cascade', () => {
  let seasonRecorders: QueryBuilderRecorder[];
  let episodeRecorders: QueryBuilderRecorder[];
  let seasonRepo: ReturnType<typeof fakeRepoWithBuilder> & {
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let episodeRepo: ReturnType<typeof fakeRepoWithBuilder>;
  let mediaRepo: { save: jest.Mock };
  let query: { findOne: jest.Mock };
  let metadata: { updateSearchVector: jest.Mock };
  let requestLifecycle: {
    onMediaMonitorChange: jest.Mock;
    onSeasonMonitorChange: jest.Mock;
  };
  let service: MediaMutationService;

  beforeEach(() => {
    seasonRecorders = [];
    episodeRecorders = [];
    seasonRepo = {
      ...fakeRepoWithBuilder(seasonRecorders),
      findOne: jest.fn(),
      save: jest.fn(),
    };
    episodeRepo = fakeRepoWithBuilder(episodeRecorders);
    mediaRepo = { save: jest.fn(async (m: unknown) => m) };
    query = { findOne: jest.fn() };
    metadata = { updateSearchVector: jest.fn() };
    requestLifecycle = {
      onMediaMonitorChange: jest.fn(),
      onSeasonMonitorChange: jest.fn(),
    };

    service = new MediaMutationService(
      mediaRepo as never,
      seasonRepo as never,
      episodeRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      query as never,
      metadata as never,
      requestLifecycle as never,
    );
  });

  it('cascades a series monitored toggle to its seasons and episodes', async () => {
    query.findOne.mockResolvedValue({ id: 7, monitored: true });

    await service.update(7, { monitored: false });

    expect(seasonRecorders).toHaveLength(1);
    expect(seasonRecorders[0].set).toEqual({ monitored: false });
    expect(seasonRecorders[0].where?.params).toEqual({ mediaIds: [7] });
    expect(seasonRecorders[0].executed).toBe(true);

    expect(episodeRecorders).toHaveLength(1);
    expect(episodeRecorders[0].set).toEqual({ monitored: false });
    expect(episodeRecorders[0].where?.clause).toContain('seasons');
    expect(episodeRecorders[0].executed).toBe(true);
  });

  it('does not cascade when the media update omits monitored', async () => {
    query.findOne.mockResolvedValue({ id: 7, monitored: true });

    await service.update(7, { title: 'x' } as never);

    expect(seasonRecorders).toHaveLength(0);
    expect(episodeRecorders).toHaveLength(0);
  });

  it('cascades a season monitored toggle to its episodes', async () => {
    seasonRepo.findOne.mockResolvedValue({
      id: 3,
      seasonNumber: 2,
      monitored: true,
      media: { id: 7 },
    });
    seasonRepo.save.mockImplementation(async (s: Season) => s);

    await service.updateSeason(3, { monitored: false });

    expect(episodeRecorders).toHaveLength(1);
    expect(episodeRecorders[0].set).toEqual({ monitored: false });
    expect(episodeRecorders[0].where?.params).toEqual({ seasonId: 3 });
    expect(episodeRecorders[0].executed).toBe(true);
  });

  it('does not cascade a season provider-only change to episodes', async () => {
    seasonRepo.findOne.mockResolvedValue({
      id: 3,
      seasonNumber: 2,
      monitored: true,
      media: { id: 7 },
    });
    seasonRepo.save.mockImplementation(async (s: Season) => s);

    await service.updateSeason(3, { preferredProvider: 'tvdb' });

    expect(episodeRecorders).toHaveLength(0);
  });
});
