import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ServerVersionService } from '../server-version.service';
import { MusicApiService } from './music-api.service';

function setup(supports: boolean) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ServerVersionService, useValue: { supportsWhenKnown: async () => supports } },
    ],
  });
  return { api: TestBed.inject(MusicApiService), http: TestBed.inject(HttpTestingController) };
}

describe('MusicApiService.recentlyPlayed', () => {
  it('reads the row from a server that serves it', async () => {
    const { api, http } = setup(true);
    const row = api.recentlyPlayed(5);
    await Promise.resolve();
    http.expectOne((r) => r.url === '/api/playback/recently-played' && r.params.get('limit') === '5').flush([{ id: 1 }]);
    expect(await row).toEqual([{ id: 1 }]);
  });

  it('is empty on an older server, without a request', async () => {
    const { api, http } = setup(false);
    expect(await api.recentlyPlayed()).toEqual([]);
    http.expectNone('/api/playback/recently-played');
  });
});

describe('MusicApiService.albumTracks', () => {
  it('sends the recording ids comma-separated, at most 50', async () => {
    const { api, http } = setup(true);
    const ids = Array.from({ length: 60 }, (_, i) => `r${i}`);
    const rows = api.albumTracks('musicbrainz', 'g1', 2, ids);
    http.expectOne((r) => r.url === '/api/music/albums/tracks' && r.params.get('recordingId') === ids.slice(0, 50).join(',')).flush([]);
    expect(await rows).toEqual([]);
  });
});
