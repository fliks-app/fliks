import { TestBed } from '@angular/core/testing';
import { HomeSettingsService, type HomeSectionPref } from './home-settings.service';
import { TvService } from './tv.service';

const lib = (id: number, name: string) => ({ id, name });
/** The zones below the carousel, which is pinned first and tested on its own. */
const zones = (svc: HomeSettingsService, ...a: Parameters<HomeSettingsService['resolve']>) =>
  svc.resolve(...a).filter((s) => s.key !== 'hero-carousel');
const keys = (sections: { key: string }[]) => sections.map((s) => s.key);

/** Built through the injector: the zone catalogue reads the form factor, so the
 *  exclusion is stated once instead of at each call site. */
const make = (isTv = false): HomeSettingsService => {
  // Reset first: a second call has to yield a fresh instance, which is what the
  // persistence tests read localStorage through.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: TvService,
        useValue: { isTv: () => isTv } as unknown as TvService,
      },
    ],
  });
  return TestBed.inject(HomeSettingsService);
};

describe('HomeSettingsService.resolve', () => {
  beforeEach(() => localStorage.clear());

  it('returns the canonical built-in order for a fresh user, libraries hidden', () => {
    const svc = make();
    expect(keys(svc.resolve([]))).toEqual([
      'hero-carousel',
      'watch-parties',
      'received-recommendations',
      'libraries',
      'continue-watching',
      'recommendations',
      'likes',
      'recently-added',
      'playlists',
      'coming-soon',
    ]);
    expect(svc.resolve([]).filter((s) => !s.visible).map((s) => s.key)).toEqual(['libraries']);
  });

  it('honours a saved order for zones still available', () => {
    const svc = make();
    svc.setOrder([
      { key: 'likes', visible: false },
      { key: 'libraries', visible: true },
      { key: 'received-recommendations', visible: true },
      { key: 'watch-parties', visible: true },
      { key: 'continue-watching', visible: true },
      { key: 'recommendations', visible: true },
      { key: 'recently-added', visible: true },
      { key: 'playlists', visible: true },
      { key: 'coming-soon', visible: true },
    ]);
    expect(keys(zones(svc, []))).toEqual([
      'likes',
      'libraries',
      'received-recommendations',
      'watch-parties',
      'continue-watching',
      'recommendations',
      'recently-added',
      'playlists',
      'coming-soon',
    ]);
    expect(zones(svc, []).find((s) => s.key === 'likes')?.visible).toBe(false);
  });

  it('appends a built-in the saved layout predates, at its canonical position', () => {
    const svc = make();
    // A layout saved before "likes" existed — every built-in but that one.
    svc.setOrder([
      { key: 'watch-parties', visible: true },
      { key: 'received-recommendations', visible: true },
      { key: 'libraries', visible: true },
      { key: 'continue-watching', visible: true },
      { key: 'recommendations', visible: true },
      { key: 'recently-added', visible: true },
      { key: 'playlists', visible: true },
      { key: 'coming-soon', visible: true },
    ]);
    expect(keys(zones(svc, []))).toEqual([
      'watch-parties',
      'received-recommendations',
      'libraries',
      'continue-watching',
      'recommendations',
      'recently-added',
      'playlists',
      'coming-soon',
      'likes',
    ]);
  });

  it('unshifts received-recommendations to the front when a saved layout predates it, instead of appending it', () => {
    const svc = make();
    svc.setOrder([
      { key: 'libraries', visible: true },
      { key: 'continue-watching', visible: true },
      { key: 'recommendations', visible: true },
      { key: 'likes', visible: true },
      { key: 'recently-added', visible: true },
      { key: 'playlists', visible: true },
      { key: 'coming-soon', visible: true },
    ]);
    expect(keys(zones(svc, [])).slice(0, 2)).toEqual(['watch-parties', 'received-recommendations']);
  });

  it('puts watch-parties on top, visible, when a saved layout predates it', () => {
    const svc = make();
    svc.setOrder([
      { key: 'received-recommendations', visible: true },
      { key: 'libraries', visible: false },
      { key: 'continue-watching', visible: true },
    ]);
    const resolved = zones(svc, []);
    expect(keys(resolved)[0]).toBe('watch-parties');
    expect(resolved[0]).toMatchObject({ type: 'watch-parties', visible: true });
    expect(resolved.find((s) => s.key === 'libraries')?.visible).toBe(false);
  });

  it('keeps a saved position and hidden state for watch-parties', () => {
    const svc = make();
    svc.setOrder([
      { key: 'received-recommendations', visible: true },
      { key: 'libraries', visible: true },
      { key: 'watch-parties', visible: false },
    ]);
    const resolved = zones(svc, []);
    expect(keys(resolved).indexOf('watch-parties')).toBe(2);
    expect(resolved[2].visible).toBe(false);
  });

  it('drops a saved zone whose library no longer exists', () => {
    const svc = make();
    svc.setOrder([
      { key: 'received-recommendations', visible: true },
      { key: 'library-recent:99', visible: true },
      { key: 'libraries', visible: true },
      { key: 'continue-watching', visible: true },
      { key: 'recommendations', visible: true },
      { key: 'likes', visible: true },
      { key: 'recently-added', visible: true },
      { key: 'playlists', visible: true },
      { key: 'coming-soon', visible: true },
    ]);
    expect(keys(zones(svc, []))).not.toContain('library-recent:99');
  });

  it('appends one hidden-by-default zone per library not yet in the saved order', () => {
    const svc = make();
    const result = zones(svc, [lib(1, 'Movies'), lib(2, 'Series')]);
    const movies = result.find((s) => s.key === 'library-recent:1');
    const series = result.find((s) => s.key === 'library-recent:2');
    expect(movies).toMatchObject({ type: 'library-recent', visible: false, libraryId: 1, libraryName: 'Movies' });
    expect(series).toMatchObject({ type: 'library-recent', visible: false, libraryId: 2, libraryName: 'Series' });
    // Appended after every built-in.
    expect(keys(result).slice(-2)).toEqual(['library-recent:1', 'library-recent:2']);
  });

  it('keeps a saved visibility/position for a library-recent zone', () => {
    const svc = make();
    svc.setOrder([
      { key: 'library-recent:1', visible: true },
      { key: 'received-recommendations', visible: true },
      { key: 'watch-parties', visible: true },
      { key: 'libraries', visible: true },
      { key: 'continue-watching', visible: true },
      { key: 'recommendations', visible: true },
      { key: 'likes', visible: true },
      { key: 'recently-added', visible: true },
      { key: 'playlists', visible: true },
      { key: 'coming-soon', visible: true },
    ]);
    const result = zones(svc, [lib(1, 'Movies')]);
    expect(keys(result)[0]).toBe('library-recent:1');
    expect(result[0].visible).toBe(true);
  });

  it('pins the carousel first, visible, over a saved layout that predates it', () => {
    const svc = make();
    svc.setOrder([{ key: 'continue-watching', visible: true }]);
    expect(svc.resolve([])[0]).toMatchObject({ type: 'hero-carousel', visible: true });
  });

  it('keeps a saved position and hidden state for the carousel', () => {
    const svc = make();
    svc.setOrder([
      { key: 'continue-watching', visible: true },
      { key: 'hero-carousel', visible: false },
    ]);
    const resolved = svc.resolve([]);
    expect(keys(resolved).indexOf('hero-carousel')).toBeGreaterThan(keys(resolved).indexOf('continue-watching'));
    expect(resolved.find((s) => s.key === 'hero-carousel')?.visible).toBe(false);
  });

  it('omits requests-recent when the caller does not opt in', () => {
    const svc = make();
    expect(keys(zones(svc, []))).not.toContain('requests-recent');
  });

  it('inserts requests-recent just above recently-added, visible by default, when opted in with no saved preference', () => {
    const svc = make();
    const result = zones(svc, [], { requests: true });
    const idx = keys(result).indexOf('requests-recent');
    expect(idx).toBe(keys(result).indexOf('recently-added') - 1);
    expect(result[idx].visible).toBe(true);
  });

  it('honours a saved position/visibility for requests-recent instead of re-slotting it', () => {
    const svc = make();
    svc.setOrder([
      { key: 'requests-recent', visible: false },
      { key: 'received-recommendations', visible: true },
      { key: 'watch-parties', visible: true },
      { key: 'libraries', visible: true },
      { key: 'continue-watching', visible: true },
      { key: 'recommendations', visible: true },
      { key: 'likes', visible: true },
      { key: 'recently-added', visible: true },
      { key: 'playlists', visible: true },
      { key: 'coming-soon', visible: true },
    ]);
    const result = zones(svc, [], { requests: true });
    expect(keys(result)[0]).toBe('requests-recent');
    expect(result[0].visible).toBe(false);
  });

  it('drops requests-recent entirely once the caller stops opting in, even if it was saved', () => {
    const svc = make();
    svc.setOrder([{ key: 'requests-recent', visible: true }]);
    expect(keys(zones(svc, []))).not.toContain('requests-recent');
  });
});

it('leaves out the zones the 10-foot UI hides, so the settings page cannot offer them', () => {
  const onTv = make(true);
  expect(keys(onTv.resolve([], { requests: true }))).not.toContain('requests-recent');
  // Same permission, other form factor: it is a TV rule, not a permission one.
  expect(keys(make(false).resolve([], { requests: true }))).toContain('requests-recent');
});

describe('HomeSettingsService persistence', () => {
  beforeEach(() => localStorage.clear());

  it('persists setOrder and setMode across instances', () => {
    const a = make();
    const order: HomeSectionPref[] = [{ key: 'likes', visible: false }];
    a.setOrder(order);
    a.setMode('media');

    const b = make();
    expect(b.settings().order).toEqual(order);
    expect(b.settings().recentlyAddedMode).toBe('media');
  });

  it('resetLayout restores canonical order/visibility but keeps the recently-added mode', () => {
    const svc = make();
    svc.setOrder([{ key: 'likes', visible: false }]);
    svc.setMode('both');
    svc.resetLayout();
    expect(keys(zones(svc, []))).toEqual([
      'watch-parties',
      'received-recommendations',
      'libraries',
      'continue-watching',
      'recommendations',
      'likes',
      'recently-added',
      'playlists',
      'coming-soon',
    ]);
    expect(svc.resolve([]).filter((s) => !s.visible).map((s) => s.key)).toEqual(['libraries']);
    expect(svc.settings().recentlyAddedMode).toBe('both');
  });
});
