import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DownloadProgressService } from './download-progress.service';

describe('DownloadProgressService', () => {
  // Core is bundled with no acquisition plugin installed, so this store must
  // expose no way at all to fetch the download-clients queue — not gated,
  // just gone — otherwise a caller could still reach a plugin route from it.
  it('exposes no seed()/queue-fetching method', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const svc = TestBed.inject(DownloadProgressService) as unknown as Record<string, unknown>;
    expect(svc['seed']).toBeUndefined();
  });

  it('folds an SSE event without any queue fetch', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const svc = TestBed.inject(DownloadProgressService);
    svc.applyProgress({
      mediaId: 1,
      mediaType: 'movie',
      progress: 0.5,
      dlspeed: 100,
      eta: 10,
      state: 'active',
    });
    expect(svc.progress().get(1)?.percent).toBe(50);
  });

  // Progress is only ever retired by an event. A download that finished while
  // the stream was down sends none, and the connect replay carries only what is
  // still live — so absence has to be read as "done" on every reconnect.
  it('drops leaves the connect snapshot no longer reports', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const svc = TestBed.inject(DownloadProgressService);
    svc.applyProgress({
      mediaId: 1,
      mediaType: 'movie',
      progress: 0.52,
      dlspeed: 100,
      eta: 10,
      state: 'active',
    });

    svc.reset();
    expect(svc.progress().size).toBe(0);

    svc.applyProgress({
      mediaId: 2,
      mediaType: 'movie',
      progress: 0.1,
      dlspeed: 100,
      eta: 10,
      state: 'active',
    });
    expect([...svc.progress().keys()]).toEqual([2]);
  });

  /**
   * `import.complete` is what retires a finished episode. It arrives with a
   * season and episode number, never a torrent ref, so it has to find the leaf
   * by the episode the leaf names — the key identifies the torrent.
   */
  describe('clearMedia', () => {
    const make = () => {
      TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
      return TestBed.inject(DownloadProgressService);
    };
    const tick = (
      svc: DownloadProgressService,
      hash: string,
      episodeNumber: number | undefined,
    ) =>
      svc.applyProgress({
        mediaId: 1,
        mediaType: 'series',
        seasonNumber: 1,
        episodeNumber,
        hash,
        progress: 0.5,
        dlspeed: 0,
        eta: 0,
        state: 'active',
      });

    it('retires the hash-keyed leaf of the imported episode', () => {
      const svc = make();
      tick(svc, 'aaa', 8);

      svc.clearMedia(1, 1, 8);

      expect(svc.progress().size).toBe(0);
    });

    it("leaves a sibling episode's torrent alone", () => {
      const svc = make();
      tick(svc, 'aaa', 8);
      tick(svc, 'bbb', 9);

      svc.clearMedia(1, 1, 8);

      expect([...svc.progress().get(1)!.seasons!.get(1)!.leaves.keys()]).toEqual(['hash:bbb']);
    });

    it('retires both releases when two were racing for that episode', () => {
      const svc = make();
      tick(svc, 'aaa', 8);
      tick(svc, 'bbb', 8);

      svc.clearMedia(1, 1, 8);

      expect(svc.progress().size).toBe(0);
    });

    // One episode landing does not finish the pack that carries the rest.
    it('keeps a season pack, which names no episode', () => {
      const svc = make();
      tick(svc, 'aaa', 8);
      tick(svc, 'pack', undefined);

      svc.clearMedia(1, 1, 8);

      expect([...svc.progress().get(1)!.seasons!.get(1)!.leaves.keys()]).toEqual(['hash:pack']);
    });

    it('drops the whole season when given no episode', () => {
      const svc = make();
      tick(svc, 'aaa', 8);
      tick(svc, 'bbb', 9);

      svc.clearMedia(1, 1);

      expect(svc.progress().size).toBe(0);
    });
  });

  /**
   * The store is fed by events alone, so a torrent that simply stops being
   * reported — deleted from the download client, or announced by a plugin too
   * old to retire it — would sit at its last percent for the life of the app.
   * The sweep is the backstop, on the same horizon the backend's replay cache
   * uses: three missed ticks of a once-a-minute publisher.
   */
  describe('staleness sweep', () => {
    const make = () => {
      TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
      return TestBed.inject(DownloadProgressService);
    };
    const sweep = (svc: DownloadProgressService) =>
      (svc as unknown as { sweepStale: () => void }).sweepStale();
    const age = (svc: DownloadProgressService, ms: number) => {
      for (const entry of svc.progress().values()) {
        if (entry.updatedAt != null) entry.updatedAt -= ms;
        for (const sp of entry.seasons?.values() ?? []) {
          for (const l of sp.leaves.values()) if (l.updatedAt != null) l.updatedAt -= ms;
        }
      }
    };
    const tick = (svc: DownloadProgressService, hash: string) =>
      svc.applyProgress({
        mediaId: 1,
        mediaType: 'series',
        seasonNumber: 1,
        episodeNumber: 8,
        hash,
        progress: 0.5,
        dlspeed: 0,
        eta: 0,
        state: 'active',
      });

    it('keeps a leaf that is still being reported', () => {
      const svc = make();
      tick(svc, 'aaa');

      sweep(svc);

      expect(svc.progress().size).toBe(1);
    });

    it('drops only the leaf that went quiet', () => {
      const svc = make();
      tick(svc, 'aaa');
      age(svc, 4 * 60_000);
      tick(svc, 'bbb');

      sweep(svc);

      expect([...svc.progress().get(1)!.seasons!.get(1)!.leaves.keys()]).toEqual(['hash:bbb']);
    });

    it('drops the media once its last leaf goes quiet', () => {
      const svc = make();
      tick(svc, 'aaa');
      age(svc, 4 * 60_000);

      sweep(svc);

      expect(svc.progress().size).toBe(0);
    });

    it("sweeps a movie's entry, which is its own leaf", () => {
      const svc = make();
      svc.applyProgress({
        mediaId: 2,
        mediaType: 'movie',
        progress: 0.5,
        dlspeed: 0,
        eta: 0,
        state: 'active',
      });
      age(svc, 4 * 60_000);

      sweep(svc);

      expect(svc.progress().size).toBe(0);
    });
  });

  /**
   * Two releases grabbed for the same episode — a second tracker's copy racing
   * the first. The leaf used to be keyed by episode number, so the second
   * overwrote the first and the header showed one download where there were two.
   */
  describe('two torrents for one episode', () => {
    const make = () => {
      TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
      return TestBed.inject(DownloadProgressService);
    };
    const tick = (svc: DownloadProgressService, hash: string, percent: number, state: 'active' | 'stalled' = 'active') =>
      svc.applyProgress({
        mediaId: 1,
        mediaType: 'series',
        seasonNumber: 1,
        episodeNumber: 8,
        hash,
        progress: percent / 100,
        dlspeed: 0,
        eta: 0,
        state,
      });

    it('keeps both, each with its own state and percent', () => {
      const svc = make();
      tick(svc, 'aaa', 12);
      tick(svc, 'bbb', 0, 'stalled');

      const leaves = svc.progress().get(1)!.seasons!.get(1)!.leaves;
      expect(leaves.size).toBe(2);
      expect([...leaves.values()].map((l) => [l.state, l.percent])).toEqual([
        ['active', 12],
        ['stalled', 0],
      ]);
    });

    it('records the episode on each, so both stay in that episode\'s scope', () => {
      const svc = make();
      tick(svc, 'aaa', 12);
      tick(svc, 'bbb', 0, 'stalled');

      const leaves = svc.progress().get(1)!.seasons!.get(1)!.leaves;
      expect([...leaves.values()].every((l) => l.episodeNumber === 8)).toBe(true);
    });

    it('retires only the one that finished', () => {
      const svc = make();
      tick(svc, 'aaa', 12);
      tick(svc, 'bbb', 0, 'stalled');

      tick(svc, 'aaa', 100);

      const leaves = svc.progress().get(1)!.seasons!.get(1)!.leaves;
      expect([...leaves.keys()]).toEqual(['hash:bbb']);
    });

    // The grab puts up a placeholder before any torrent exists; it has no ref to
    // be matched on, so the first real tick has to stand in for it explicitly.
    it('supersedes the placeholder its own grab put up', () => {
      const svc = make();
      const release = svc.markGrabbing({ mediaId: 1, mediaType: 'series', seasonNumber: 1, episodeNumber: 8 });

      tick(svc, 'aaa', 12);

      const leaves = svc.progress().get(1)!.seasons!.get(1)!.leaves;
      expect([...leaves.keys()]).toEqual(['hash:aaa']);
      release();
      expect([...svc.progress().get(1)!.seasons!.get(1)!.leaves.keys()]).toEqual(['hash:aaa']);
    });
  });

  /**
   * Speed and ETA are per torrent. They used to be written onto the media
   * entry by every tick, so with concurrent episodes the figure shown was
   * whichever leaf happened to report last, not the download's.
   */
  describe('speed and ETA across concurrent episodes', () => {
    const make = () => {
      TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
      return TestBed.inject(DownloadProgressService);
    };
    const tick = (svc: DownloadProgressService, episodeNumber: number, dlspeed: number, eta: number) =>
      svc.applyProgress({
        mediaId: 1,
        mediaType: 'series',
        seasonNumber: 1,
        episodeNumber,
        progress: 0.5,
        dlspeed,
        eta,
        state: 'active',
      });

    it('keeps each leaf its own', () => {
      const svc = make();
      tick(svc, 6, 1000, 120);
      tick(svc, 8, 2000, 60);

      const leaves = svc.progress().get(1)!.seasons!.get(1)!.leaves;
      expect(leaves.get(6)?.dlspeed).toBe(1000);
      expect(leaves.get(8)?.dlspeed).toBe(2000);
    });

    it('sums the speed and takes the longest ETA for the media', () => {
      const svc = make();
      tick(svc, 6, 1000, 120);
      tick(svc, 8, 2000, 60);

      const entry = svc.progress().get(1)!;
      expect(entry.dlspeed).toBe(3000);
      expect(entry.eta).toBe(120);
    });

    it('drops a finished leaf from the totals', () => {
      const svc = make();
      tick(svc, 6, 1000, 120);
      tick(svc, 8, 2000, 60);

      svc.applyProgress({
        mediaId: 1,
        mediaType: 'series',
        seasonNumber: 1,
        episodeNumber: 6,
        progress: 1,
        dlspeed: 0,
        eta: 0,
        state: 'active',
      });

      const entry = svc.progress().get(1)!;
      expect(entry.dlspeed).toBe(2000);
      expect(entry.eta).toBe(60);
    });
  });

  /**
   * A series tick with no season number cannot be placed. The plugin sends one
   * for a history row that never got a season/episode id, so it is a steady
   * state — merging it onto whichever leaf happened to be alone attributed
   * another torrent's percent to that episode, and taking the movie branch
   * flattened the entry and lost the season map with it.
   */
  describe('a series tick with no season', () => {
    const make = () => {
      TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
      return TestBed.inject(DownloadProgressService);
    };
    const seed = (svc: DownloadProgressService) =>
      svc.applyProgress({
        mediaId: 1,
        mediaType: 'series',
        seasonNumber: 1,
        episodeNumber: 8,
        hash: 'aaa',
        progress: 0.1,
        dlspeed: 0,
        eta: 0,
        state: 'active',
      });
    const unattributed = (svc: DownloadProgressService, progress: number) =>
      svc.applyProgress({
        mediaId: 1,
        mediaType: 'series',
        progress,
        dlspeed: 9,
        eta: 5,
        state: 'active',
      });

    it("leaves a known leaf's own percent alone", () => {
      const svc = make();
      seed(svc);

      unattributed(svc, 0.6);

      expect(svc.progress().get(1)?.seasons?.get(1)?.leaves.get('hash:aaa')?.percent).toBe(10);
    });

    it('never flattens the entry into the movie shape', () => {
      const svc = make();
      seed(svc);

      unattributed(svc, 0.6);

      expect(svc.progress().get(1)?.seasons?.size).toBe(1);
    });

    it('creates nothing when there is no entry to place it against', () => {
      const svc = make();

      unattributed(svc, 0.6);

      expect(svc.progress().size).toBe(0);
    });
  });

  /**
   * The window between pressing grab and a torrent existing. Modelled as an
   * ordinary leaf so the header's season/episode scoping needs no special case
   * — and so a failed search clears with the request instead of sticking.
   */
  describe('markGrabbing', () => {
    const make = () => {
      TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
      return TestBed.inject(DownloadProgressService);
    };
    const episode = { mediaId: 1, mediaType: 'series' as const, seasonNumber: 1, episodeNumber: 8 };

    it('keys the phase to the episode, so a sibling page stays clear', () => {
      const svc = make();
      svc.markGrabbing(episode);
      const leaves = svc.progress().get(1)?.seasons?.get(1)?.leaves;
      expect([...(leaves?.keys() ?? [])]).toEqual([8]);
      expect(leaves?.get(8)?.state).toBe('searching');
    });

    it('releases the phase when the search fails', () => {
      const svc = make();
      svc.markGrabbing(episode)();
      expect(svc.progress().size).toBe(0);
    });

    // Every real tick carries a ref, so these use one: a hash-less payload is a
    // shape production never emits, and it is exactly the shape where a guard
    // that reconstructs a key from the episode number passes by accident.
    it('leaves a real torrent alone once it takes over', () => {
      const svc = make();
      const release = svc.markGrabbing(episode);
      svc.applyProgress({ ...episode, hash: 'aaa', progress: 0.4, dlspeed: 1, eta: 2, state: 'active' });

      release();

      expect(svc.progress().get(1)?.seasons?.get(1)?.leaves.get('hash:aaa')).toEqual(
        expect.objectContaining({ state: 'active', percent: 40 }),
      );
    });

    it('never downgrades a torrent already reporting to a search', () => {
      const svc = make();
      svc.applyProgress({ ...episode, hash: 'aaa', progress: 0.4, dlspeed: 1, eta: 2, state: 'active' });

      svc.markGrabbing(episode)();

      const leaves = svc.progress().get(1)!.seasons!.get(1)!.leaves;
      expect([...leaves.keys()]).toEqual(['hash:aaa']);
      expect(leaves.get('hash:aaa')?.state).toBe('active');
    });

    it("drops only its own leaf, not a sibling's download", () => {
      const svc = make();
      svc.applyProgress({
        mediaId: 1,
        mediaType: 'series',
        seasonNumber: 1,
        episodeNumber: 3,
        hash: 'bbb',
        progress: 0.5,
        dlspeed: 1,
        eta: 2,
        state: 'active',
      });

      svc.markGrabbing(episode)();

      expect([...(svc.progress().get(1)?.seasons?.get(1)?.leaves.keys() ?? [])]).toEqual([
        'hash:bbb',
      ]);
    });
  });
});
