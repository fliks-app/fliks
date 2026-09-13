import { armPageSlide, nextSlide, resetPageSlide } from './page-slide';

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
    resetPageSlide();
    back(false);
  });

  it('slides into a page a card stacked, and back out of it', () => {
    armPageSlide();
    expect(nextSlide(home(), library())).toBe('push');

    back(true);
    expect(nextSlide(library(), home())).toBe('pop');
  });

  it('takes any pair, not a listed one', () => {
    armPageSlide();
    expect(nextSlide(episode(), episode())).toBe('push');
  });

  it('leaves a push the morph animates alone, on the way back too', () => {
    armPageSlide();
    expect(nextSlide(home(), route('movies/:id'), true)).toBeNull();

    // Nothing was stacked, so the trip back is the morph's as well.
    back(true);
    expect(nextSlide(route('movies/:id'), home())).toBeNull();
  });

  it('keeps the page a slide put down while a morph opens and closes over it', () => {
    armPageSlide();
    expect(nextSlide(home(), library())).toBe('push');
    armPageSlide();
    expect(nextSlide(library(), route('movies/:id'), true)).toBeNull();

    back(true);
    // The morph owns this one, and must not spend the library's pop on it.
    expect(nextSlide(route('movies/:id'), library(), true)).toBeNull();
    expect(nextSlide(library(), home())).toBe('pop');
  });

  it('leaves a trip the rail started alone, both ways', () => {
    expect(nextSlide(home(), library())).toBeNull();
    // Nothing slid in, so there is nothing to slide back out of — this is the
    // trip a back button takes, with no gesture of its own to read.
    back(true);
    expect(nextSlide(library(), home())).toBeNull();
  });

  it('never takes the player, which animates its own open and close', () => {
    armPageSlide();
    expect(nextSlide(episode(), player())).toBeNull();

    back(true);
    expect(nextSlide(player(), episode())).toBeNull();
  });

  it('pops once per page stacked', () => {
    armPageSlide();
    nextSlide(home(), library());
    armPageSlide();
    nextSlide(library(), episode());

    back(true);
    expect(nextSlide(episode(), library())).toBe('pop');
    expect(nextSlide(library(), home())).toBe('pop');
    expect(nextSlide(home(), home())).toBeNull();
  });

  it('puts the stack down when the rail takes over', () => {
    armPageSlide();
    expect(nextSlide(home(), library())).toBe('push');

    resetPageSlide();

    back(true);
    expect(nextSlide(library(), home())).toBeNull();
  });

  it('forgets an arming the navigation it starts does not use', () => {
    armPageSlide();
    nextSlide(home(), library());

    expect(nextSlide(library(), episode())).toBeNull();
  });
});
