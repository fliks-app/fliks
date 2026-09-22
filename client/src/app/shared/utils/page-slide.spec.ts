import {
  armPageSlide,
  confirmPush,
  consumeArmed,
  goingBack,
  nextSlide,
  releaseStackedPop,
  resetStack,
} from './page-slide';

/** What these guard is the gesture, not the route pair: the same two pages, in
 *  the same order, slide or don't depending on what started the trip. */
describe('page slide', () => {
  function route(path: string) {
    return { routeConfig: null, firstChild: { routeConfig: { path }, firstChild: null } };
  }
  const home = () => route('');
  const library = () => route('libraries/:libraryName');
  const episode = () => route('series/:id/episode/:episodeId');
  const player = () => route('watch/:mediaFileId');
  const back = (on: boolean) => document.documentElement.classList.toggle('nav-back', on);

  beforeEach(() => {
    consumeArmed();
    resetStack();
    back(false);
  });

  it('slides into a page a card stacked, and back out of it', () => {
    armPageSlide();
    expect(nextSlide(home(), library(), consumeArmed())).toBe('push');
    confirmPush(true);

    back(true);
    expect(nextSlide(library(), home(), consumeArmed())).toBe('pop');
  });

  it('takes any pair, not a listed one', () => {
    armPageSlide();
    expect(nextSlide(episode(), episode(), consumeArmed())).toBe('push');
  });

  it('leaves a push the morph animates alone, on the way back too', () => {
    armPageSlide();
    expect(nextSlide(home(), route('movies/:id'), consumeArmed(), true)).toBeNull();

    // Nothing was stacked, so the trip back is the morph's as well.
    back(true);
    expect(nextSlide(route('movies/:id'), home(), consumeArmed())).toBeNull();
  });

  it('keeps the page a slide put down while a morph opens and closes over it', () => {
    armPageSlide();
    expect(nextSlide(home(), library(), consumeArmed())).toBe('push');
    confirmPush(true);
    armPageSlide();
    expect(nextSlide(library(), route('movies/:id'), consumeArmed(), true)).toBeNull();

    back(true);
    // The morph owns this one, and must not spend the library's pop on it.
    expect(nextSlide(route('movies/:id'), library(), consumeArmed(), true)).toBeNull();
    expect(nextSlide(library(), home(), consumeArmed())).toBe('pop');
  });

  it('leaves a trip the rail started alone, both ways', () => {
    expect(nextSlide(home(), library(), consumeArmed())).toBeNull();
    // Nothing slid in, so there is nothing to slide back out of — this is the
    // trip a back button takes, with no gesture of its own to read.
    back(true);
    expect(nextSlide(library(), home(), consumeArmed())).toBeNull();
  });

  it('never takes the player, which animates its own open and close', () => {
    armPageSlide();
    expect(nextSlide(episode(), player(), consumeArmed())).toBeNull();

    back(true);
    expect(nextSlide(player(), episode(), consumeArmed())).toBeNull();
  });

  it('pops once per page stacked', () => {
    armPageSlide();
    nextSlide(home(), library(), consumeArmed());
    confirmPush(true);
    armPageSlide();
    nextSlide(library(), episode(), consumeArmed());
    confirmPush(true);

    back(true);
    expect(nextSlide(episode(), library(), consumeArmed())).toBe('pop');
    expect(nextSlide(library(), home(), consumeArmed())).toBe('pop');
    expect(nextSlide(home(), home(), consumeArmed())).toBeNull();
  });

  it('puts the stack down when the rail takes over', () => {
    armPageSlide();
    expect(nextSlide(home(), library(), consumeArmed())).toBe('push');

    resetStack();

    back(true);
    expect(nextSlide(library(), home(), consumeArmed())).toBeNull();
  });

  it('drops an arming once consumed, even by a guard that returns early after', () => {
    armPageSlide();
    // Stands in for the hook's hoisted read, ahead of every early-return guard.
    expect(consumeArmed()).toBe(true);
    // Nothing left for a later navigation to find armed.
    expect(consumeArmed()).toBe(false);

    expect(nextSlide(home(), library(), consumeArmed())).toBeNull();
  });

  it('forgets an arming the navigation it starts does not use', () => {
    armPageSlide();
    nextSlide(home(), library(), consumeArmed());

    expect(nextSlide(library(), episode(), consumeArmed())).toBeNull();
  });

  it('pops on the way back out of a page an arming is still stranded on', () => {
    armPageSlide();
    expect(nextSlide(home(), library(), consumeArmed())).toBe('push');
    confirmPush(true);

    // A pointerdown on a card the scroll took over: armed, but nothing navigated.
    armPageSlide();
    back(true);
    expect(nextSlide(library(), home(), consumeArmed())).toBe('pop');
  });

  it('does not slide back out of a page it never stacked', () => {
    armPageSlide();
    back(true);
    expect(nextSlide(library(), home(), consumeArmed())).toBeNull();
  });

  it('gives its pop back on a swipe-back that never reaches nextSlide, backgrounded or not', () => {
    armPageSlide();
    expect(nextSlide(home(), library(), consumeArmed())).toBe('push');
    confirmPush(true);

    // nav-back is set at NavigationStart, ahead of the hook — same order here.
    back(true);
    // The gesture animates itself and the hook skips before nextSlide runs, be it
    // for the gesture itself or for the app backgrounding mid-trip — either way
    // this is the only place the counter can settle.
    releaseStackedPop(library(), home());

    expect(nextSlide(library(), home(), consumeArmed())).toBeNull();
  });

  it('leaves the stack alone for an armed swipe-back that never went back', () => {
    armPageSlide();
    expect(nextSlide(home(), library(), consumeArmed())).toBe('push');
    confirmPush(true);

    // The gesture committed (native flag up) but handleBackButton() closed a
    // layer instead of navigating — select/dialog/sheet/overlay — so nav-back
    // was never set. Nothing here is a pop to give back.
    expect(goingBack()).toBe(false);
    releaseStackedPop(library(), home());

    back(true);
    expect(nextSlide(library(), home(), consumeArmed())).toBe('pop');
  });

  it('leaves a morph-owned trip for a swipe-back to skip', () => {
    armPageSlide();
    expect(nextSlide(home(), library(), consumeArmed())).toBe('push');
    confirmPush(true);

    // Entered the poster page by the morph, not the slide: nothing owed here.
    releaseStackedPop(route('movies/:id'), library());

    back(true);
    expect(nextSlide(library(), home(), consumeArmed())).toBe('pop');
  });

  it('does not owe a pop for a push that never slid', () => {
    armPageSlide();
    expect(nextSlide(home(), library(), consumeArmed())).toBe('push');
    // slidePage() returned false — no dock, e.g. the keyboard was open.
    confirmPush(false);

    back(true);
    expect(nextSlide(library(), home(), consumeArmed())).toBeNull();
  });
});
