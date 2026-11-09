import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import type { Media } from '../../../core/services/api/media.service';
import type { AlbumDetail, Track } from '../../../core/services/api/music.models';
import { AuthService } from '../../../core/services/auth.service';
import { MusicDownloadsService } from '../../../core/services/music-downloads.service';
import { PartyService } from '../../../core/services/party/party.service';
import { bookSpecProviders } from '../book/book-test-setup';
import { AlbumPageComponent } from './album-page.component';

const track = (itemId: number, o: Partial<Track> = {}): Track => ({
  itemId, editionId: 1, mediaFileId: itemId, hasFile: true, orphaned: false, discNumber: 1, discTitle: null, position: itemId,
  trackNumber: itemId, label: null, title: 'T' + itemId, durationSeconds: 100, explicit: false, gain: null, peak: null, artists: [],
  credits: [], works: [], favourite: false, playCount: 0, lastPlayedAt: null, ...o,
});
const edition = (id: number) => ({ id, title: null, country: 'FR', hasFiles: true, orphaned: false, albumGain: -6, albumPeak: 1 });
const album = (tracks: Track[]) =>
  ({ primaryType: 'Album', secondaryTypes: [], orphaned: false, targetEditionId: 1, artists: [{ id: 5, name: 'Band', creditedName: null, joinPhrase: null }], editions: [edition(1), edition(2)], tracks }) as unknown as AlbumDetail;

const playerStub = () => ({
  playTracks: vi.fn(async () => {}),
  enqueueTracks: vi.fn(),
  toggle: vi.fn(),
  setShuffle: vi.fn(),
  shuffle: signal(false),
  musicMode: signal(false),
  playing: signal(false),
  track: signal<{ mediaId: number; itemId: number } | null>(null),
});

function setup(tracks: Track[]) {
  const player = playerStub();
  TestBed.configureTestingModule({
    providers: bookSpecProviders(
      { provide: AudioPlayerService, useValue: player },
      { provide: PartyService, useValue: { active: () => false } },
      { provide: MusicDownloadsService, useValue: { available: () => true, itemIds: () => new Set<number>(), tracks: () => new Map(), progress: () => null, state: () => 'none', download: vi.fn(), remove: vi.fn() } },
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
    const actions = (fixture.componentInstance as unknown as { actions: () => Record<string, () => void> }).actions();
    actions['media.identify']!();
    http.expectOne('/api/media/9/music/candidates').flush([]);
  });

  it('draws a work heading only over a group of tracks', () => {
    const work = (workId: number) => [{ workId, title: 'W' + workId, composerName: null, position: 1 }] as unknown as Track['works'];
    const { el } = setup([track(1, { works: work(1) }), track(2, { works: work(2) }), track(3, { works: work(2) })]);
    expect(el.querySelectorAll('[data-testid="work"]').length).toBe(1);
  });

  it('opens the edition facts from the actions menu', () => {
    const { fixture, el } = setup([track(1)]);
    const dialog = el.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn();
    (fixture.componentInstance as unknown as { actions: () => Record<string, () => void> }).actions()['media.details']!();
    expect(dialog.showModal).toHaveBeenCalled();
  });

  it('offers the profiles of its audio want only to an editor', () => {
    const actionsOf = (canEdit: boolean) => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: bookSpecProviders(
          { provide: AudioPlayerService, useValue: playerStub() },
          { provide: PartyService, useValue: { active: () => false } },
          { provide: MusicDownloadsService, useValue: { available: () => true, itemIds: () => new Set<number>(), tracks: () => new Map(), progress: () => null, state: () => 'none', download: vi.fn(), remove: vi.fn() } },
          { provide: AuthService, useValue: { hasPermission: () => canEdit, user: () => null, sessionEpoch: () => 0 } },
        ),
      });
      const fixture = TestBed.createComponent(AlbumPageComponent);
      fixture.componentRef.setInput('media', { id: 9, type: 'album', title: 'Alb', posterUrl: null, providers: [{}], album: album([track(1)]) } as unknown as Media);
      fixture.detectChanges();
      return { fixture, actions: (fixture.componentInstance as unknown as { actions: () => Record<string, () => void> }).actions() };
    };
    expect(actionsOf(false).actions['media.edit-profiles']).toBeUndefined();
    const { fixture, actions } = actionsOf(true);
    const dialog = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="wants-dialog"]') as HTMLDialogElement;
    dialog.showModal = vi.fn();
    actions['media.edit-profiles']!();
    expect(dialog.showModal).toHaveBeenCalled();
  });

  it('toggles shuffle without starting playback', () => {
    const { el, player } = setup([track(1)]);
    (el.querySelector('[data-testid="shuffle"]') as HTMLButtonElement).click();
    expect(player.setShuffle).toHaveBeenCalledWith(true);
    expect(player.playTracks).not.toHaveBeenCalled();
  });

  it('pauses the album it plays and marks its current track', () => {
    const { el, fixture, player } = setup([track(1), track(2)]);
    player.musicMode.set(true);
    player.playing.set(true);
    player.track.set({ mediaId: 9, itemId: 2 });
    fixture.detectChanges();
    (el.querySelector('[data-testid="play"]') as HTMLButtonElement).click();
    expect(player.toggle).toHaveBeenCalled();
    expect(player.playTracks).not.toHaveBeenCalled();
    expect(el.querySelectorAll('[data-testid="track"] .text-primary').length).toBe(1);
  });

  it('skips the tracks without a file when playing', () => {
    const { el, player } = setup([track(1, { hasFile: false }), track(2)]);
    (el.querySelector('[data-testid="play"]') as HTMLButtonElement).click();
    expect((player.playTracks.mock.calls[0] as unknown[])[0]).toHaveLength(1);
  });

  it('likes a track through the item like', () => {
    const { http, el } = setup([track(1)]);
    (el.querySelector('[data-testid="heart"]') as HTMLButtonElement).click();
    const req = http.expectOne((r) => r.method === 'POST' && r.url === '/api/likes');
    expect(req.request.body).toEqual({ mediaId: 9, episodeId: 1 });
  });
});
