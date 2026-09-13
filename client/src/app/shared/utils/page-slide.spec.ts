import { armPageSlide, nextSlide, resetPageSlide } from './page-slide';

/** What these guard is the gesture, not the route pair: the same two pages, in
 *  the same order, slide or don't depending on what started the trip. */
describe('page slide', () => {
  function route(path: string) {
    return { routeConfig: null, firstChild: { routeConfig: { path }, firstChild: null } };
  }
  const home = () => route('');
  const library = () => route('libraries/:libraryName');

  beforeEach(() => resetPageSlide());

  it('slides into a page a card stacked, and back out of it', () => {
    armPageSlide();

    expect(nextSlide(home(), library())).toBe('push');
    expect(nextSlide(library(), home())).toBe('pop');
  });

  it('leaves a trip the rail started alone, both ways', () => {
    expect(nextSlide(home(), library())).toBeNull();
    // Nothing slid in, so there is nothing to slide back out of — this is the
    // trip a back button takes, with no gesture of its own to read.
    expect(nextSlide(library(), home())).toBeNull();
  });

  it('forgets an arming the navigation it starts does not use', () => {
    armPageSlide();

    expect(nextSlide(home(), route('movies/:id'))).toBeNull();
    expect(nextSlide(home(), library())).toBeNull();
  });

  it('puts the stack down when the rail takes over', () => {
    armPageSlide();
    expect(nextSlide(home(), library())).toBe('push');

    resetPageSlide();

    expect(nextSlide(library(), home())).toBeNull();
  });

  it('pops once, never on the trip after', () => {
    armPageSlide();
    nextSlide(home(), library());

    expect(nextSlide(library(), home())).toBe('pop');
    expect(nextSlide(library(), home())).toBeNull();
  });
});
