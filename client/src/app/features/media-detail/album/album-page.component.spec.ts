import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import type { Media } from '../../../core/services/api/media.service';
import type { AlbumDetail, Track } from '../../../core/services/api/music.models';
import { AuthService } from '../../../core/services/auth.service';
import { bookSpecProviders } from '../book/book-test-setup';
import { AlbumPageComponent } from './album-page.component';

const track = (itemId: number, o: Partial<Track> = {}): Track => ({
  itemId, editionId: 1, mediaFileId: itemId, hasFile: true, orphaned: false, discNumber: 1, discTitle: null, position: itemId,
  trackNumber: itemId, label: null, title: 'T' + itemId, durationSeconds: 100, explicit: false, gain: null, peak: null, artists: [],
  credits: [], works: [], favourite: false, rating: null, playCount: 0, lastPlayedAt: null, ...o,
});
const edition = (id: number) => ({ id, title: null, country: 'FR', hasFiles: true, orphaned: false, albumGain: -6, albumPeak: 1 });
const album = (tracks: Track[]) =>
  ({ primaryType: 'Album', secondaryTypes: [], orphaned: false, targetEditionId: 1, artists: [{ id: 5, name: 'Band', creditedName: null, joinPhrase: null }], editions: [edition(1), edition(2)], tracks }) as unknown as AlbumDetail;

function setup(tracks: Track[]) {
  const player = { playTracks: vi.fn(async () => {}), enqueueTracks: vi.fn() };
  TestBed.configureTestingModule({
    providers: bookSpecProviders(
      { provide: AudioPlayerService, useValue: player },
      { provide: AuthService, useValue: { hasPermission: () => false, user: () => null, sessionEpoch: () => 0 } },
    ),
  });
  const fixture = TestBed.createComponent(AlbumPageComponent);
  fixture.componentRef.setInput('media', { id: 9, type: 'album', title: 'Alb', posterUrl: null, providers: [{}], album: album(tracks) } as unknown as Media);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  return { fixture, player, http, el: fixture.nativeElement as HTMLElement };
}

describe('AlbumPageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lists the tracks of the default edition only', () => {
    const { el } = setup([track(1), track(2), track(3, { editionId: 2 })]);
    expect(el.querySelectorAll('[data-testid="track"]').length).toBe(2);
  });

  it('plays the album from a clicked track with the album facts', () => {
    const { el, player } = setup([track(1), track(2)]);
    (el.querySelectorAll('[data-testid="track"]')[1]!.querySelector('button') as HTMLButtonElement).click();
    const [reqs, start] = player.playTracks.mock.calls[0] as unknown as [{ itemId: number; albumGain: number; artists: string }[], number];
    expect(start).toBe(1);
    expect(reqs.map((r) => r.itemId)).toEqual([1, 2]);
    expect(reqs[0]).toMatchObject({ albumGain: -6, artists: 'Band' });
  });

  it('puts Play and Shuffle in the hero action row', () => {
    const { el } = setup([track(1)]);
    const row = el.querySelector('[data-hero-actions]')!;
    expect(row.querySelector('[data-testid="play"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="shuffle"]')).not.toBeNull();
  });

  it('identifies from the actions menu by listing the candidate releases', () => {
    const { fixture, http } = setup([track(1)]);
    const actions = (fixture.componentInstance as unknown as { actions: Record<string, () => void> }).actions;
    actions['media.identify']!();
    http.expectOne('/api/media/9/music/candidates').flush([]);
  });

  it('skips the tracks without a file when playing', () => {
    const { el, player } = setup([track(1, { hasFile: false }), track(2)]);
    (el.querySelector('[data-testid="play"]') as HTMLButtonElement).click();
    expect((player.playTracks.mock.calls[0] as unknown[])[0]).toHaveLength(1);
  });

  it('rates a track and clears it on the same star', async () => {
    const { fixture, http, el } = setup([track(1)]);
    const star = (n: number) => el.querySelectorAll('[data-testid="star"]')[n - 1] as HTMLButtonElement;
    star(4).click();
    http.expectOne((r) => r.method === 'PUT' && r.url === '/api/items/1/rating').flush(null);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(star(4).getAttribute('aria-pressed')).toBe('true');
    star(4).click();
    http.expectOne((r) => r.method === 'DELETE' && r.url === '/api/items/1/rating').flush(null);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(star(4).getAttribute('aria-pressed')).toBe('false');
  });

  it('likes a track through the item like', () => {
    const { http, el } = setup([track(1)]);
    (el.querySelector('[data-testid="heart"]') as HTMLButtonElement).click();
    const req = http.expectOne((r) => r.method === 'POST' && r.url === '/api/likes');
    expect(req.request.body).toEqual({ mediaId: 9, episodeId: 1 });
  });
});
