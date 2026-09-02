import {
  clearPosterStamps,
  clearStalePosterStamps,
  markViewTransition,
  stampPoster,
  viewTransitionRunning,
} from './view-transition';

/** The stamp deliberately outlives the click that set it (the back transition
 *  reads it again), so the regressions worth guarding are both about a STALE
 *  stamp pairing the destination poster with the wrong card. */
describe('view-transition poster stamps', () => {
  function img(): HTMLImageElement {
    const el = document.createElement('img');
    document.body.appendChild(el);
    return el;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('leaves only the newly stamped image named', () => {
    const first = img();
    const second = img();

    stampPoster(first, 7);
    expect(first.style.viewTransitionName).toBe('media-poster-7');

    stampPoster(second, 9);
    expect(second.style.viewTransitionName).toBe('media-poster-9');
    // Same media in two rows would otherwise abort the transition on a
    // duplicate name; a different media would animate from the wrong card.
    expect(first.style.viewTransitionName).toBe('');
  });

  it('lifts the clicked card\'s badges with its poster', () => {
    const card = img();
    const overlay = document.createElement('div');
    overlay.setAttribute('data-card-overlay', '');
    document.body.appendChild(overlay);

    stampPoster(card, 7, null, overlay);
    expect(overlay.style.viewTransitionName).toBe('media-card-overlay');

    // A second card must not leave two overlays named: a duplicate aborts the
    // whole transition.
    stampPoster(img(), 9);
    expect(overlay.style.viewTransitionName).toBe('');
  });

  it('names an episode target on the episode id, not the series', () => {
    const card = img();

    stampPoster(card, 5, 42);

    // The episode page's hero is the still; the series name would pair the
    // card with the poster and morph it into the wrong image.
    expect(card.style.viewTransitionName).toBe('media-poster-ep-42');
  });

  it('clears every stamp for a navigation that owns no poster', () => {
    const card = img();
    stampPoster(card, 7);

    clearPosterStamps();

    expect(card.style.viewTransitionName).toBe('');
  });

  describe('clearStalePosterStamps', () => {
    /** Mirrors the root snapshot the router hands the hook: its own routeConfig
     *  is null, the path sits on the leaf. */
    function route(path: string) {
      return { routeConfig: null, firstChild: { routeConfig: { path }, firstChild: null } };
    }

    it('keeps the stamp while a poster page is on either side', () => {
      const card = img();
      stampPoster(card, 7);

      clearStalePosterStamps(route(''), route('movies/:id'));
      expect(card.style.viewTransitionName).toBe('media-poster-7');

      // Back navigation: the morph reads the stamp on the re-attached card.
      clearStalePosterStamps(route('series/:id'), route(''));
      expect(card.style.viewTransitionName).toBe('media-poster-7');
    });

    it('drops a stamp left over from an earlier detail visit', () => {
      const card = img();
      stampPoster(card, 7);

      clearStalePosterStamps(route(''), route('search'));

      expect(card.style.viewTransitionName).toBe('');
    });
  });
});

describe('markViewTransition', () => {
  it('flags the document while the transition runs and clears it after', async () => {
    let settle!: () => void;
    const finished = new Promise<void>((r) => (settle = r));

    markViewTransition({ finished });
    expect(viewTransitionRunning()).toBe(true);

    settle();
    await finished;
    await Promise.resolve();
    expect(viewTransitionRunning()).toBe(false);
  });
});
