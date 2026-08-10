import { HomeSettingsService, type HomeSectionPref } from './home-settings.service';

const lib = (id: number, name: string) => ({ id, name });
const keys = (sections: { key: string }[]) => sections.map((s) => s.key);

describe('HomeSettingsService.resolve', () => {
  beforeEach(() => localStorage.clear());

  it('returns the canonical built-in order, all visible, for a fresh user', () => {
    const svc = new HomeSettingsService();
    expect(keys(svc.resolve([]))).toEqual([
      'received-recommendations',
      'libraries',
      'continue-watching',
      'recommendations',
      'likes',
      'recently-added',
      'playlists',
      'coming-soon',
    ]);
    expect(svc.resolve([]).every((s) => s.visible)).toBe(true);
  });

  it('honours a saved order for zones still available', () => {
    const svc = new HomeSettingsService();
    svc.setOrder([
      { key: 'likes', visible: false },
      { key: 'libraries', visible: true },
      { key: 'received-recommendations', visible: true },
      { key: 'continue-watching', visible: true },
      { key: 'recommendations', visible: true },
      { key: 'recently-added', visible: true },
      { key: 'playlists', visible: true },
      { key: 'coming-soon', visible: true },
    ]);
    expect(keys(svc.resolve([]))).toEqual([
      'likes',
      'libraries',
      'received-recommendations',
      'continue-watching',
      'recommendations',
      'recently-added',
      'playlists',
      'coming-soon',
    ]);
    expect(svc.resolve([]).find((s) => s.key === 'likes')?.visible).toBe(false);
  });

  it('appends a built-in the saved layout predates, at its canonical position', () => {
    const svc = new HomeSettingsService();
    // A layout saved before "likes" existed — every built-in but that one.
    svc.setOrder([
      { key: 'received-recommendations', visible: true },
      { key: 'libraries', visible: true },
      { key: 'continue-watching', visible: true },
      { key: 'recommendations', visible: true },
      { key: 'recently-added', visible: true },
      { key: 'playlists', visible: true },
      { key: 'coming-soon', visible: true },
    ]);
    expect(keys(svc.resolve([]))).toEqual([
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
    const svc = new HomeSettingsService();
    svc.setOrder([
      { key: 'libraries', visible: true },
      { key: 'continue-watching', visible: true },
      { key: 'recommendations', visible: true },
      { key: 'likes', visible: true },
      { key: 'recently-added', visible: true },
      { key: 'playlists', visible: true },
      { key: 'coming-soon', visible: true },
    ]);
    expect(keys(svc.resolve([]))[0]).toBe('received-recommendations');
  });

  it('drops a saved zone whose library no longer exists', () => {
    const svc = new HomeSettingsService();
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
    expect(keys(svc.resolve([]))).not.toContain('library-recent:99');
  });

  it('appends one hidden-by-default zone per library not yet in the saved order', () => {
    const svc = new HomeSettingsService();
    const result = svc.resolve([lib(1, 'Movies'), lib(2, 'Series')]);
    const movies = result.find((s) => s.key === 'library-recent:1');
    const series = result.find((s) => s.key === 'library-recent:2');
    expect(movies).toMatchObject({ type: 'library-recent', visible: false, libraryId: 1, libraryName: 'Movies' });
    expect(series).toMatchObject({ type: 'library-recent', visible: false, libraryId: 2, libraryName: 'Series' });
    // Appended after every built-in.
    expect(keys(result).slice(-2)).toEqual(['library-recent:1', 'library-recent:2']);
  });

  it('keeps a saved visibility/position for a library-recent zone', () => {
    const svc = new HomeSettingsService();
    svc.setOrder([
      { key: 'library-recent:1', visible: true },
      { key: 'received-recommendations', visible: true },
      { key: 'libraries', visible: true },
      { key: 'continue-watching', visible: true },
      { key: 'recommendations', visible: true },
      { key: 'likes', visible: true },
      { key: 'recently-added', visible: true },
      { key: 'playlists', visible: true },
      { key: 'coming-soon', visible: true },
    ]);
    const result = svc.resolve([lib(1, 'Movies')]);
    expect(keys(result)[0]).toBe('library-recent:1');
    expect(result[0].visible).toBe(true);
  });

  it('omits requests-recent when the caller does not opt in', () => {
    const svc = new HomeSettingsService();
    expect(keys(svc.resolve([]))).not.toContain('requests-recent');
  });

  it('inserts requests-recent just above recently-added, visible by default, when opted in with no saved preference', () => {
    const svc = new HomeSettingsService();
    const result = svc.resolve([], { requests: true });
    const idx = keys(result).indexOf('requests-recent');
    expect(idx).toBe(keys(result).indexOf('recently-added') - 1);
    expect(result[idx].visible).toBe(true);
  });

  it('honours a saved position/visibility for requests-recent instead of re-slotting it', () => {
    const svc = new HomeSettingsService();
    svc.setOrder([
      { key: 'requests-recent', visible: false },
      { key: 'received-recommendations', visible: true },
      { key: 'libraries', visible: true },
      { key: 'continue-watching', visible: true },
      { key: 'recommendations', visible: true },
      { key: 'likes', visible: true },
      { key: 'recently-added', visible: true },
      { key: 'playlists', visible: true },
      { key: 'coming-soon', visible: true },
    ]);
    const result = svc.resolve([], { requests: true });
    expect(keys(result)[0]).toBe('requests-recent');
    expect(result[0].visible).toBe(false);
  });

  it('drops requests-recent entirely once the caller stops opting in, even if it was saved', () => {
    const svc = new HomeSettingsService();
    svc.setOrder([{ key: 'requests-recent', visible: true }]);
    expect(keys(svc.resolve([]))).not.toContain('requests-recent');
  });
});

describe('HomeSettingsService persistence', () => {
  beforeEach(() => localStorage.clear());

  it('persists setOrder and setMode across instances', () => {
    const a = new HomeSettingsService();
    const order: HomeSectionPref[] = [{ key: 'likes', visible: false }];
    a.setOrder(order);
    a.setMode('media');

    const b = new HomeSettingsService();
    expect(b.settings().order).toEqual(order);
    expect(b.settings().recentlyAddedMode).toBe('media');
  });

  it('resetLayout restores canonical order/visibility but keeps the recently-added mode', () => {
    const svc = new HomeSettingsService();
    svc.setOrder([{ key: 'likes', visible: false }]);
    svc.setMode('both');
    svc.resetLayout();
    expect(keys(svc.resolve([]))).toEqual([
      'received-recommendations',
      'libraries',
      'continue-watching',
      'recommendations',
      'likes',
      'recently-added',
      'playlists',
      'coming-soon',
    ]);
    expect(svc.resolve([]).every((s) => s.visible)).toBe(true);
    expect(svc.settings().recentlyAddedMode).toBe('both');
  });
});
