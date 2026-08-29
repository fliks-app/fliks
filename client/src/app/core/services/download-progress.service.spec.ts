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
   * A series tick with no season number. Older plugin builds sent these, and
   * the movie branch used to replace the whole entry — destroying the season
   * map, so the detail modal lost the episode it was naming and the badge went
   * back to showing on every episode page of the show.
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
        progress: 0.1,
        dlspeed: 0,
        eta: 0,
        state: 'active',
      });

    it('updates the sole leaf instead of flattening the entry', () => {
      const svc = make();
      seed(svc);

      svc.applyProgress({
        mediaId: 1,
        mediaType: 'series',
        progress: 0.6,
        dlspeed: 9,
        eta: 5,
        state: 'active',
      });

      const leaf = svc.progress().get(1)?.seasons?.get(1)?.leaves.get(8);
      expect(leaf?.percent).toBe(60);
      expect(svc.progress().get(1)?.dlspeed).toBe(9);
    });

    it('retires the sole leaf when it reports done', () => {
      const svc = make();
      seed(svc);

      svc.applyProgress({
        mediaId: 1,
        mediaType: 'series',
        progress: 1,
        dlspeed: 0,
        eta: 0,
        state: 'active',
      });

      expect(svc.progress().size).toBe(0);
    });

    it('keeps the structure rather than guessing when several leaves are in flight', () => {
      const svc = make();
      seed(svc);
      svc.applyProgress({
        mediaId: 1,
        mediaType: 'series',
        seasonNumber: 1,
        episodeNumber: 9,
        progress: 0.2,
        dlspeed: 0,
        eta: 0,
        state: 'active',
      });

      svc.applyProgress({
        mediaId: 1,
        mediaType: 'series',
        progress: 0.9,
        dlspeed: 0,
        eta: 0,
        state: 'active',
      });

      const leaves = svc.progress().get(1)?.seasons?.get(1)?.leaves;
      expect(leaves?.get(8)?.percent).toBe(10);
      expect(leaves?.get(9)?.percent).toBe(20);
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

    it('leaves a real torrent alone once it takes over', () => {
      const svc = make();
      const release = svc.markGrabbing(episode);
      svc.applyProgress({ ...episode, progress: 0.4, dlspeed: 1, eta: 2, state: 'active' });

      release();

      expect(svc.progress().get(1)?.seasons?.get(1)?.leaves.get(8)).toEqual(
        expect.objectContaining({ state: 'active', percent: 40 }),
      );
    });

    it('never downgrades a torrent already reporting to a search', () => {
      const svc = make();
      svc.applyProgress({ ...episode, progress: 0.4, dlspeed: 1, eta: 2, state: 'active' });

      svc.markGrabbing(episode)();

      expect(svc.progress().get(1)?.seasons?.get(1)?.leaves.get(8)?.state).toBe('active');
    });

    it("drops only its own leaf, not a sibling's download", () => {
      const svc = make();
      svc.applyProgress({
        mediaId: 1,
        mediaType: 'series',
        seasonNumber: 1,
        episodeNumber: 3,
        progress: 0.5,
        dlspeed: 1,
        eta: 2,
        state: 'active',
      });

      svc.markGrabbing(episode)();

      expect([...(svc.progress().get(1)?.seasons?.get(1)?.leaves.keys() ?? [])]).toEqual([3]);
    });
  });
});
