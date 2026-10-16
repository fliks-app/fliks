import { existsSync } from 'fs';
import { Subject } from 'rxjs';
import { PostImportService } from './post-import.service';
import type { DomainEvent, SseEvent } from './events.service';
import { bridgeGenerateSprite, bridgeScanSource } from '../bridge/server-bridge';

jest.mock('../bridge/server-bridge', () => ({
  bridgeGenerateSprite: jest.fn(),
  bridgeScanSource: jest.fn(),
}));

jest.mock('fs', () => ({
  ...(jest.requireActual('fs') as object),
  existsSync: jest.fn(),
}));

const hasSprite = existsSync as jest.MockedFunction<typeof existsSync>;

/** Let the (timer-free) post-import promise chain run to completion. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise(process.nextTick);
};

function harness() {
  const domain = new Subject<DomainEvent>();
  const sse = new Subject<SseEvent>();
  const files = [{ id: 1 }, { id: 2 }];
  const mediaFileRepo = {
    find: jest.fn().mockResolvedValue(files),
    findOne: jest.fn().mockImplementation(({ where }: { where: { id: number } }) =>
      Promise.resolve({
        id: where.id,
        relativePath: `f${where.id}.mkv`,
        episodeId: null,
        media: { path: '/lib/show', title: 'Placeholder Show' },
      }),
    ),
  };
  const events = {
    onDomain: (h: (e: DomainEvent) => void) => domain.subscribe(h),
    subscribe: (h: (e: SseEvent) => void) => sse.subscribe(h),
    emit: jest.fn(),
  };
  const thumbnails = {
    getMetadataPath: (id: number) => `/cache/${id}/sprite.json`,
  };
  const markers = { autoDetectMissing: jest.fn().mockResolvedValue(undefined) };
  const settings = { get: jest.fn().mockResolvedValue(null) };
  const postImportQueue = { whenIdle: jest.fn().mockResolvedValue(undefined) };
  const activityRegistry = {
    upsertPending: jest.fn(),
    upsertRunning: jest.fn(),
    remove: jest.fn(),
  };
  const service = new PostImportService(
    mediaFileRepo as never,
    events as never,
    thumbnails as never,
    markers as never,
    settings as never,
    postImportQueue as never,
    activityRegistry as never,
  );
  service.onModuleInit();
  return {
    service,
    domain,
    sse,
    events,
    mediaFileRepo,
    thumbnails,
    markers,
    settings,
    postImportQueue,
    activityRegistry,
  };
}

describe('PostImportService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    hasSprite.mockReturnValue(false);
    jest.mocked(bridgeGenerateSprite).mockReset().mockResolvedValue({ interval: 5 } as never);
    jest.mocked(bridgeScanSource).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => jest.useRealTimers());

  it('generates the missing sprites and detects markers after an import settles', async () => {
    const h = harness();

    h.domain.next({ type: 'media.files.imported', mediaId: 7, source: 'download' });
    expect(bridgeGenerateSprite).not.toHaveBeenCalled();

    jest.advanceTimersByTime(PostImportService.SETTLE_MS);
    await settle();

    expect(bridgeGenerateSprite).toHaveBeenCalledTimes(2);
    expect(h.markers.autoDetectMissing).toHaveBeenCalledWith(7);
    h.service.onModuleDestroy();
  });

  it('skips files that already have a sprite on disk', async () => {
    const h = harness();
    hasSprite.mockImplementation((p) => String(p).includes('/1/'));

    h.sse.next({ type: 'rescan.completed', mediaId: 7, title: 't', added: 1, removed: 0, updated: 0 });
    jest.advanceTimersByTime(PostImportService.SETTLE_MS);
    await settle();

    expect(bridgeGenerateSprite).toHaveBeenCalledTimes(1);
    expect(jest.mocked(bridgeGenerateSprite).mock.calls[0][0]).toBe(2);
    h.service.onModuleDestroy();
  });

  it('coalesces an import wave into a single pass per media', async () => {
    const h = harness();

    for (const episodeNumber of [1, 2, 3]) {
      h.domain.next({ type: 'media.files.imported', mediaId: 7, seasonNumber: 1, episodeNumber, source: 'download' });
      jest.advanceTimersByTime(PostImportService.SETTLE_MS / 2);
    }
    jest.advanceTimersByTime(PostImportService.SETTLE_MS);
    await settle();

    // One pass = 3 `find` calls: the clock scan's, the ids-only load, then one
    // batch join resolving progress titles for the whole missing list.
    expect(h.mediaFileRepo.find).toHaveBeenCalledTimes(3);
    expect(h.markers.autoDetectMissing).toHaveBeenCalledTimes(1);
    h.service.onModuleDestroy();
  });

  it('skips sprite generation when the toggle is off, markers still run', async () => {
    const h = harness();
    h.settings.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'sprites_auto_generate_on_import' ? 'false' : null),
    );

    h.domain.next({ type: 'media.files.imported', mediaId: 7, source: 'download' });
    jest.advanceTimersByTime(PostImportService.SETTLE_MS);
    await settle();

    expect(bridgeGenerateSprite).not.toHaveBeenCalled();
    expect(h.markers.autoDetectMissing).toHaveBeenCalledWith(7);
    h.service.onModuleDestroy();
  });

  it('reports progress under the bulk sprite command scoped to the media', async () => {
    const h = harness();

    h.domain.next({ type: 'media.files.imported', mediaId: 7, source: 'download' });
    jest.advanceTimersByTime(PostImportService.SETTLE_MS);
    await settle();

    const commands = h.events.emit.mock.calls.map((c) => c[0].command);
    expect(new Set(commands)).toEqual(new Set(['GenerateMissingSprites:7']));
    const last = h.events.emit.mock.calls.at(-1)![0];
    expect(last.current).toBe(last.total);
    h.service.onModuleDestroy();
  });

  it('only schedules the source scans for a rescan that added nothing', async () => {
    const h = harness();
    h.mediaFileRepo.find.mockResolvedValue([
      { id: 1, relativePath: 'f1.mkv', streamInfo: null, media: { path: '/lib/show' } },
    ]);

    h.sse.next({ type: 'rescan.completed', mediaId: 7, title: 't', added: 0, removed: 2, updated: 0 });
    jest.advanceTimersByTime(PostImportService.SETTLE_MS);
    await settle();

    expect(bridgeScanSource).toHaveBeenCalledWith(1);
    expect(bridgeGenerateSprite).not.toHaveBeenCalled();
    expect(h.markers.autoDetectMissing).not.toHaveBeenCalled();
    h.service.onModuleDestroy();
  });
});
