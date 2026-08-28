import { clearPosterStamps, stampPoster } from './view-transition';

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

  it('clears every stamp for a navigation that owns no poster', () => {
    const card = img();
    stampPoster(card, 7);

    clearPosterStamps();

    expect(card.style.viewTransitionName).toBe('');
  });
});
