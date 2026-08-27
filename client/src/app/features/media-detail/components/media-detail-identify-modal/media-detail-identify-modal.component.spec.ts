import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect } from 'vitest';
import { provideTranslateService } from '@ngx-translate/core';
import { MediaDetailIdentifyModalComponent } from './media-detail-identify-modal.component';
import { MetadataService, MetadataSearchResult } from '../../../../core/services/api/metadata.service';
import { MediaService } from '../../../../core/services/api/media.service';
import { ToastService } from '../../../../core/services/toast.service';
import type { MediaType } from '../../../../core/enums/media-type.enum';

/**
 * A work TVDB knows but TheMovieDB does not is reported with `tmdbId: 0` — the
 * provider's "no cross-reference" sentinel. Forwarding it identifies the media
 * against nothing and the API rejects it, so the whole re-identification fails.
 */
describe('MediaDetailIdentifyModalComponent — a TVDB-only result', () => {
  const tvdbOnly: MetadataSearchResult = {
    tmdbId: 0,
    tvdbId: 4242,
    imdbId: 'tt0499308',
    provider: 'tvdb',
    title: 'A Series',
    originalTitle: 'A Series',
    overview: '',
    year: 2007,
    posterUrl: null,
    rating: 0,
    genres: [],
    mediaType: ('series' satisfies MediaType),
    existingMediaId: null,
    existingMediaType: null,
  };

  function setup() {
    const identify = vi.fn(() => Promise.resolve({} as never));
    const searchTv = vi.fn(() => Promise.resolve([]));
    TestBed.configureTestingModule({
      imports: [MediaDetailIdentifyModalComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService(),
        { provide: MetadataService, useValue: { searchTv, searchMovie: vi.fn() } },
        { provide: MediaService, useValue: { identify } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(MediaDetailIdentifyModalComponent);
    const cmp = fixture.componentInstance;
    cmp.config.set({
      mediaId: 795,
      mediaType: ('series' satisfies MediaType),
      title: 'Old',
      year: null,
      path: null,
      tmdbId: 10,
      tvdbId: null,
      imdbId: null,
    });
    return { cmp, identify, searchTv };
  }

  it('VERDICT: sends no tmdbId when the provider has none, so the API accepts it', async () => {
    const { cmp, identify } = setup();

    await cmp.apply(tvdbOnly, 0);

    expect(identify).toHaveBeenCalledWith(795, { tvdbId: 4242, imdbId: 'tt0499308' });
  });

  it('still sends a real tmdbId', async () => {
    const { cmp, identify } = setup();

    await cmp.apply({ ...tvdbOnly, tmdbId: 77 }, 0);

    expect(identify).toHaveBeenCalledWith(795, { tmdbId: 77, tvdbId: 4242, imdbId: 'tt0499308' });
  });

  it('searches with the media id so the server picks its library provider', async () => {
    const { cmp, searchTv } = setup();
    cmp.formTitle.set('A Series');

    await cmp.search();

    expect(searchTv).toHaveBeenCalledWith('A Series', undefined, undefined, 795);
  });

  it('keys the in-flight spinner by row, not by the shared 0 id', async () => {
    const { cmp } = setup();
    const pending = cmp.apply(tvdbOnly, 2);

    expect(cmp.applyingId()).toBe(2);
    await pending;
  });
});
