import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { LibrariesApiService, type LibrarySummary } from './api/libraries-api.service';
import { MyLibrariesService } from './my-libraries.service';

describe('MyLibrariesService', () => {
  const setup = (cached: LibrarySummary[] | null) => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: LibrariesApiService, useValue: { cachedMine: () => Promise.resolve(cached) } },
      ],
    });
    return TestBed.inject(MyLibrariesService);
  };

  it('restores the cached list as loaded', async () => {
    const libs = [{ id: 1, name: 'Movies' }] as LibrarySummary[];
    const s = setup(libs);
    await s.restore();
    expect(s.list()).toEqual(libs);
    expect(s.loaded()).toBe(true);
  });

  it('stays unloaded without a cached list, so the nav waits for the network', async () => {
    const s = setup(null);
    await s.restore();
    expect(s.loaded()).toBe(false);
  });
});
