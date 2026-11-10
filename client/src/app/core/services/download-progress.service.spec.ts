import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { DownloadProgressItem, DownloadProgressService } from './download-progress.service';
import { ServerVersionService } from './server-version.service';

function make(): DownloadProgressService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()] });
  return TestBed.inject(DownloadProgressService);
}

function download(over: Partial<DownloadProgressItem> = {}): DownloadProgressItem {
  return { ref: 'aaa', progress: 0.5, dlspeed: 0, eta: 0, state: 'active', ...over };
}

const series = (svc: DownloadProgressService, downloads: DownloadProgressItem[], mediaId = 1) =>
  svc.applyProgress({ mediaId, mediaType: 'series', downloads });

const movie = (svc: DownloadProgressService, downloads: DownloadProgressItem[], mediaId = 1) =>
  svc.applyProgress({ mediaId, mediaType: 'movie', downloads });

const leafKeys = (svc: DownloadProgressService, mediaId = 1, seasonNumber = 1) =>
  [...(svc.progress().get(mediaId)?.seasons?.get(seasonNumber)?.leaves.keys() ?? [])];

describe('DownloadProgressService hydrate', () => {
  function withServer(supports: boolean): { svc: DownloadProgressService; http: HttpTestingController } {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ServerVersionService, useValue: { supportsWhenKnown: async () => supports } },
      ],
    });
    return { svc: TestBed.inject(DownloadProgressService), http: TestBed.inject(HttpTestingController) };
  }

  it('reads the downloads in flight from a server that serves them', async () => {
    const { svc, http } = withServer(true);
    const done = svc.hydrate();
    await Promise.resolve();
    http.expectOne('/api/acquisition/progress').flush([{ mediaId: 1, mediaType: 'movie', downloads: [download()] }]);
    await done;
    expect(svc.progress().get(1)?.percent).toBe(50);
  });

  it('asks an older server nothing and leaves the list empty', async () => {
    const { svc, http } = withServer(false);
    await svc.hydrate();
    http.expectNone('/api/acquisition/progress');
    expect(svc.progress().size).toBe(0);
  });
});

describe('DownloadProgressService', () => {
  // Core is bundled with no acquisition plugin installed, so this store must expose no way at
  // all to fetch the download-clients queue — not gated, just gone.
  it('exposes no seed()/queue-fetching method', () => {
    const svc = make() as unknown as Record<string, unknown>;
    expect(svc['seed']).toBeUndefined();
  });

  it('folds a movie snapshot without any queue fetch', () => {
    const svc = make();
    movie(svc, [download({ progress: 0.5, dlspeed: 100, eta: 10 })]);
    expect(svc.progress().get(1)?.percent).toBe(50);
  });

  it('drops everything on reset, for the SSE connect replay to re-state', () => {
    const svc = make();
    movie(svc, [download()]);
    svc.reset();
    expect(svc.progress().size).toBe(0);
  });
});

/**
 * The point of the snapshot shape. Every consumer used to rebuild the set from per-download
 * upserts, so a download that stopped being reported — deleted from the client, above all — sat
 * at its last percent until a timeout swept it. Absence is now the retirement.
 */
describe('DownloadProgressService — a snapshot replaces', () => {
  it('VERDICT: a download absent from the next snapshot is gone, with no retirement event', () => {
    const svc = make();
    series(svc, [
      download({ ref: 'aaa', seasonNumber: 1, episodeNumber: 7 }),
      download({ ref: 'bbb', seasonNumber: 1, episodeNumber: 8 }),
    ]);
    expect(leafKeys(svc)).toEqual(['ref:aaa', 'ref:bbb']);

    series(svc, [download({ ref: 'bbb', seasonNumber: 1, episodeNumber: 8 })]);
    expect(leafKeys(svc)).toEqual(['ref:bbb']);
  });

  it('VERDICT: an empty snapshot retires the media outright', () => {
    const svc = make();
    series(svc, [download({ ref: 'aaa', seasonNumber: 1 })]);
    series(svc, []);
    expect(svc.progress().has(1)).toBe(false);
  });

  it('an empty snapshot for an unknown media changes nothing', () => {
    const svc = make();
    series(svc, [download({ ref: 'aaa', seasonNumber: 1 })], 1);
    series(svc, [], 2);
    expect([...svc.progress().keys()]).toEqual([1]);
  });

  it('two downloads for the same episode stay two leaves', () => {
    const svc = make();
    series(svc, [
      download({ ref: 'aaa', seasonNumber: 1, episodeNumber: 8, progress: 0.2 }),
      download({ ref: 'bbb', seasonNumber: 1, episodeNumber: 8, progress: 0.6 }),
    ]);
    expect(leafKeys(svc)).toEqual(['ref:aaa', 'ref:bbb']);
  });

  it('sums speed across concurrent downloads and takes the longest ETA', () => {
    const svc = make();
    series(svc, [
      download({ ref: 'aaa', seasonNumber: 1, episodeNumber: 7, dlspeed: 1024, eta: 120 }),
      download({ ref: 'bbb', seasonNumber: 1, episodeNumber: 8, dlspeed: 2048, eta: 60 }),
    ]);
    const entry = svc.progress().get(1)!;
    expect(entry.dlspeed).toBe(3072);
    expect(entry.eta).toBe(120);
  });

  it('drops a series download the reporter could not place under a season', () => {
    const svc = make();
    series(svc, [download({ ref: 'aaa' })]);
    expect(svc.progress().has(1)).toBe(false);
  });
});

/**
 * A grab the user just clicked has no download to report it yet. It is held apart from the
 * reported set precisely so a snapshot, which replaces that set wholesale, cannot erase it.
 */
describe('DownloadProgressService — markGrabbing', () => {
  const scope = { mediaId: 1, mediaType: 'series' as const, seasonNumber: 1, episodeNumber: 8 };

  it('shows the scope as searching from the click', () => {
    const svc = make();
    svc.markGrabbing(scope);
    expect(svc.progress().get(1)?.state).toBe('searching');
  });

  it('the release drops it, so a failed search leaves no badge up', () => {
    const svc = make();
    svc.markGrabbing(scope)();
    expect(svc.progress().has(1)).toBe(false);
  });

  it('VERDICT: a snapshot for another episode does not erase it', () => {
    const svc = make();
    svc.markGrabbing(scope);
    series(svc, [download({ ref: 'aaa', seasonNumber: 1, episodeNumber: 3 })]);

    expect(leafKeys(svc)).toEqual(['ref:aaa', 'pending:1:8']);
  });

  it('a snapshot reporting that very scope supersedes it', () => {
    const svc = make();
    svc.markGrabbing(scope);
    series(svc, [download({ ref: 'aaa', seasonNumber: 1, episodeNumber: 8 })]);

    expect(leafKeys(svc)).toEqual(['ref:aaa']);
  });

  it('says nothing when a download is already reporting for the scope', () => {
    const svc = make();
    series(svc, [download({ ref: 'aaa', seasonNumber: 1, episodeNumber: 8 })]);
    svc.markGrabbing(scope);
    expect(leafKeys(svc)).toEqual(['ref:aaa']);
  });
});

/** `import.complete` retires a finished download ahead of the publisher's next snapshot. */
describe('DownloadProgressService — clearMedia', () => {
  const twoEpisodes = (svc: DownloadProgressService) =>
    series(svc, [
      download({ ref: 'aaa', seasonNumber: 1, episodeNumber: 7 }),
      download({ ref: 'bbb', seasonNumber: 1, episodeNumber: 8 }),
    ]);

  it('drops only the imported episode, leaving its siblings advancing', () => {
    const svc = make();
    twoEpisodes(svc);
    svc.clearMedia(1, 1, 8);
    expect(leafKeys(svc)).toEqual(['ref:aaa']);
  });

  it('a season import drops the whole season, pack included', () => {
    const svc = make();
    twoEpisodes(svc);
    svc.clearMedia(1, 1);
    expect(svc.progress().has(1)).toBe(false);
  });

  it('keeps a pack an episode import does not finish', () => {
    const svc = make();
    series(svc, [
      download({ ref: 'pack', seasonNumber: 1 }),
      download({ ref: 'bbb', seasonNumber: 1, episodeNumber: 8 }),
    ]);
    svc.clearMedia(1, 1, 8);
    expect(leafKeys(svc)).toEqual(['ref:pack']);
  });

  it('with no season it drops the media', () => {
    const svc = make();
    movie(svc, [download()]);
    svc.clearMedia(1);
    expect(svc.progress().has(1)).toBe(false);
  });
});

describe('DownloadProgressService hydrate', () => {
  function makeHttp(): { svc: DownloadProgressService; http: HttpTestingController } {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()],
    });
    return { svc: TestBed.inject(DownloadProgressService), http: TestBed.inject(HttpTestingController) };
  }

  const snapshot = (mediaId: number, ref: string) => ({
    mediaId,
    mediaType: 'movie',
    downloads: [download({ ref, progress: 0.2 })],
  });

  it('states what is in flight for a client that connects late', async () => {
    const { svc, http } = makeHttp();
    const done = svc.hydrate();
    http.expectOne('/api/acquisition/progress').flush([snapshot(1, 'a'), snapshot(2, 'b')]);
    await done;
    expect([...svc.progress().keys()]).toEqual([1, 2]);
  });

  it('never replaces a media a later event already stated', async () => {
    const { svc, http } = makeHttp();
    const done = svc.hydrate();
    movie(svc, [download({ progress: 0.9 })], 1);
    http.expectOne('/api/acquisition/progress').flush([snapshot(1, 'a'), snapshot(2, 'b')]);
    await done;
    expect(svc.progress().get(1)?.percent).toBe(90);
    expect(svc.progress().has(2)).toBe(true);
  });

  it('keeps a download that has not changed for minutes', async () => {
    vi.useFakeTimers();
    try {
      const svc = make();
      movie(svc, [download()]);
      vi.advanceTimersByTime(10 * 60_000);
      expect(svc.progress().has(1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
