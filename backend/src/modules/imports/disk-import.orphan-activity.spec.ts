import { ActivityRegistryService } from '../scheduler/activity-registry.service';
import { DiskImportService, ORPHAN_IMPORT_PROGRESS } from './disk-import.service';
import { RelinkOrphansDto } from './dto/relink-orphans.dto';
import { MediaType } from '../../common/enums';

const group = (folderName: string): RelinkOrphansDto =>
  ({
    libraryId: 1,
    type: MediaType.MOVIE,
    externalId: '1',
    folderName,
    files: [],
  }) as RelinkOrphansDto;

function makeService(registry: ActivityRegistryService) {
  return new DiskImportService(
    null as never, // mediaRepo
    null as never, // fileRepo
    null as never, // seasonRepo
    null as never, // episodeRepo
    null as never, // mediaService
    null as never, // naming
    null as never, // libraries — makes every relinkOrphans throw
    null as never, // metadata
    null as never, // nfo
    null as never, // libraryIngest
    null as never, // postImportQueue
    null as never, // mediaServers
    { emit: jest.fn() } as never,
    registry,
  );
}

describe('orphan batch activity', () => {
  let registry: ActivityRegistryService;
  let service: DiskImportService;

  beforeEach(() => {
    jest.useFakeTimers();
    registry = new ActivityRegistryService({ emit: jest.fn() } as never);
    service = makeService(registry);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('pre-registers the whole backlog under the batch row', async () => {
    const pending = jest.spyOn(registry, 'upsertPending');
    await service.relinkOrphansBatch([group('A Folder'), group('B Folder')], null);

    expect(pending).toHaveBeenCalledTimes(2);
    for (const [id, type, subject, parentId] of pending.mock.calls) {
      expect(type).toBe(ORPHAN_IMPORT_PROGRESS);
      expect(parentId).toBe(ORPHAN_IMPORT_PROGRESS);
      expect(id).toContain(subject?.title);
    }
  });

  it('reports the group the batch is on against the total', async () => {
    const running = jest.spyOn(registry, 'upsertRunning');
    await service.relinkOrphansBatch([group('A Folder'), group('B Folder')], null);

    const batchRows = running.mock.calls.filter(([id]) => id === ORPHAN_IMPORT_PROGRESS);
    expect(batchRows.map(([, , , current, total]) => [current, total])).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  // Every group fails here (no repositories), which is the case that would leak.
  it('leaves nothing in the registry once the batch is done', async () => {
    await service.relinkOrphansBatch([group('A Folder'), group('B Folder')], null);
    expect(registry.list(1, 50)).toMatchObject({ data: [], total: 0 });
  });
});
