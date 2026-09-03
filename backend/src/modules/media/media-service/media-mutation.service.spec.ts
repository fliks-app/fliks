import * as fs from 'fs';
import * as path from 'path';
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
      { emitDomain: jest.fn() } as never,
      { deleteForFile: jest.fn() } as never,
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

describe('MediaMutationService remove disk cleanup', () => {
  let mediaRepo: { remove: jest.Mock };
  let mediaServers: { dispatch: jest.Mock };
  let query: { findOne: jest.Mock };
  let requestLifecycle: { onMediaRemoved: jest.Mock };
  let rmSpy: jest.SpyInstance;
  let service: MediaMutationService;

  /** Build a media whose virtual `path` getter resolves to root/folderName. */
  function mediaIn(root: string | undefined, folderName: string | undefined) {
    return {
      id: 1,
      title: 'placeholder',
      library: root ? { path: root } : undefined,
      get path() {
        return this.library?.path && folderName
          ? path.join(this.library.path, folderName)
          : null;
      },
    };
  }

  beforeEach(() => {
    mediaRepo = { remove: jest.fn() };
    mediaServers = { dispatch: jest.fn() };
    query = { findOne: jest.fn() };
    requestLifecycle = { onMediaRemoved: jest.fn() };
    rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);

    service = new MediaMutationService(
      mediaRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mediaServers as never,
      query as never,
      {} as never,
      requestLifecycle as never,
      { emitDomain: jest.fn() } as never,
      { deleteForFile: jest.fn() } as never,
    );
  });

  afterEach(() => rmSpy.mockRestore());

  it('removes the DB record and returns the folder to delete', async () => {
    query.findOne.mockResolvedValue(mediaIn('/library/movies', 'Some Movie (2020)'));

    const result = await service.remove(1);

    expect(result.diskPath).toBe(path.resolve('/library/movies/Some Movie (2020)'));
    expect(mediaRepo.remove).toHaveBeenCalled();
    // Disk deletion is deferred to the caller, not done inside remove().
    expect(rmSpy).not.toHaveBeenCalled();
  });

  it('returns no folder when the media has no folder path', async () => {
    query.findOne.mockResolvedValue(mediaIn('/library/movies', undefined));

    const result = await service.remove(1);

    expect(result.diskPath).toBeNull();
    expect(mediaRepo.remove).toHaveBeenCalled();
  });

  it('returns no folder when the path escapes the library root', async () => {
    query.findOne.mockResolvedValue(mediaIn('/library/movies', '../../etc'));

    const result = await service.remove(1);

    expect(result.diskPath).toBeNull();
    expect(mediaRepo.remove).toHaveBeenCalled();
  });

  it('returns no folder when the path resolves to the library root', async () => {
    query.findOne.mockResolvedValue(mediaIn('/library/movies', '.'));

    const result = await service.remove(1);

    expect(result.diskPath).toBeNull();
    expect(mediaRepo.remove).toHaveBeenCalled();
  });

  it('deleteMediaFolder removes the folder recursively', async () => {
    await service.deleteMediaFolder('/library/movies/Some Movie (2020)');

    expect(rmSpy).toHaveBeenCalledWith('/library/movies/Some Movie (2020)', {
      recursive: true,
      force: true,
    });
  });
});
