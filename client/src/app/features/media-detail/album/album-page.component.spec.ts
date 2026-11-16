import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import type { Media } from '../../../core/services/api/media.service';
import type { AlbumDetail, Track } from '../../../core/services/api/music.models';
import { AuthService } from '../../../core/services/auth.service';
import { SseService } from '../../../core/services/sse.service';
import { Subject } from 'rxjs';
import { MusicDownloadsService } from '../../../core/services/music-downloads.service';
import { CardActionsService } from '../../../core/services/card-actions.service';
import { PartyService } from '../../../core/services/party/party.service';
import { bookSpecProviders } from '../book/book-test-setup';
import { AlbumPageComponent } from './album-page.component';

const track = (itemId: number, o: Partial<Track> = {}): Track => ({
  itemId, mediaFileId: itemId, hasFile: true, monitored: true, orphaned: false, discNumber: 1, discTitle: null, position: itemId,
  trackNumber: itemId, label: null, title: 'T' + itemId, durationSeconds: 100, explicit: false, gain: null, peak: null, artists: [],
  credits: [], works: [], favourite: false, playCount: 0, lastPlayedAt: null, ...o,
});
const release = { title: null, country: 'FR', disambiguation: 'Deluxe', trackCount: 3, releaseDate: '2005-01-01', albumGain: -6, albumPeak: 1, coverUrl: null };
const versions = [
  { releaseId: 'r-self', title: 'Alb', disambiguation: 'Deluxe', country: 'FR', releaseDate: '2005-01-01', trackCount: 3, discCount: 1, mediaId: 9 },
  { releaseId: 'r-held', title: 'Alb', disambiguation: null, country: 'US', releaseDate: '2004-01-01', trackCount: 2, discCount: 1, mediaId: 12 },
  { releaseId: 'r-new', title: 'Alb', disambiguation: 'Live', country: null, releaseDate: null, trackCount: 1, discCount: 1, mediaId: null },
];
const album = (tracks: Track[]) =>
  ({ primaryType: 'Album', secondaryTypes: [], orphaned: false, artists: [{ id: 5, name: 'Band', creditedName: null, joinPhrase: null }], release, sharedTracks: 0, versions, tracks }) as unknown as AlbumDetail;

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

function setup(tracks: Track[], perms: string[] = [], extra: Partial<Media> = {}) {
  const player = playerStub();
  TestBed.configureTestingModule({
    providers: bookSpecProviders(
      { provide: AudioPlayerService, useValue: player },
      { provide: PartyService, useValue: { active: () => false } },
      { provide: MusicDownloadsService, useValue: { available: () => true, itemIds: () => new Set<number>(), tracks: () => new Map(), progress: () => null, state: () => 'none', download: vi.fn(), remove: vi.fn() } },
      { provide: AuthService, useValue: { hasPermission: (p: string) => perms.includes(p), user: () => null, sessionEpoch: () => 0 } },
      { provide: SseService, useValue: { likeEvents: new Subject() } },
    ),
  });
  const fixture = TestBed.createComponent(AlbumPageComponent);
  fixture.componentRef.setInput('media', { id: 9, type: 'album', title: 'Alb', posterUrl: null, providers: [{}], album: album(tracks), ...extra } as unknown as Media);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  return { fixture, player, http, el: fixture.nativeElement as HTMLElement };
}

describe('AlbumPageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lists the whole tracklist, greying the tracks nobody wants', () => {
    const { el } = setup([track(1), track(2), track(3, { hasFile: false, monitored: false })]);
    const rows = el.querySelectorAll('[data-testid="track"]');
    expect(rows.length).toBe(3);
    expect(rows[2]!.querySelector('button')!.classList.contains('opacity-50')).toBe(true);
    expect(rows[0]!.querySelector('button')!.classList.contains('opacity-50')).toBe(false);
  });

  it('shows the release label and the other versions, held ones linking to their album', () => {
    const { el } = setup([track(1)]);
    expect(el.querySelector('[data-testid="version"]')!.textContent).toContain('Deluxe');
    const links = [...el.querySelectorAll('[data-testid="version-link"]')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/albums/12', '/add/album/musicbrainz/r-new']);
  });

  it('lets an adder want an unwanted track from its row, and the whole album at once', () => {
    const { fixture, el, http } = setup([track(1), track(2, { hasFile: false, monitored: false, recordingId: 'r2' })], ['media.create', 'media.edit'], {
      preferredProvider: 'musicbrainz', externalIds: [{ provider: 'musicbrainz', value: 'rel1' }],
    } as Partial<Media>);
    expect(el.querySelectorAll('[data-testid="track-add"]').length).toBe(1);
    (el.querySelector('[data-testid="want-all"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.method === 'PUT' && r.url === '/api/media/9').flush({});
    return fixture.whenStable().then(() => {
      fixture.detectChanges();
      expect(el.querySelector('[data-testid="track-add"]')).toBeNull();
      expect((el.querySelector('[data-testid="want-all"]') as HTMLButtonElement).disabled).toBe(true);
    });
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

  it('opens the shared panel with the track actions on a track menu', () => {
    const { el, player } = setup([track(1), track(2, { hasFile: false })]);
    (el.querySelectorAll('[data-testid="track-menu"]')[0] as HTMLButtonElement).click();
    const panel = TestBed.inject(CardActionsService);
    expect(panel.title()).toBe('T1');
    expect(panel.actions()!.map((a) => a.icon)).toEqual(['list-start', 'list-end', 'list-plus', 'download']);
    panel.actions()![0]!.run();
    expect(player.enqueueTracks).toHaveBeenCalledWith([expect.objectContaining({ itemId: 1 })], 'next');
  });

  it('draws a work heading only over a group of tracks', () => {
    const work = (workId: number) => [{ workId, title: 'W' + workId, composerName: null, position: 1 }] as unknown as Track['works'];
    const { el } = setup([track(1, { works: work(1) }), track(2, { works: work(2) }), track(3, { works: work(2) })]);
    expect(el.querySelectorAll('[data-testid="work"]').length).toBe(1);
  });

  it('opens the release facts from the actions menu', () => {
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
          { provide: SseService, useValue: { likeEvents: new Subject() } },
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

  it('shows each track of a requester as available, requested or requestable', async () => {
    const { fixture, http, el } = setup(
      [track(1), track(2, { hasFile: false, recordingId: 'r2' }), track(3, { hasFile: false, recordingId: 'r3' })],
      ['requests.create'],
      { preferredProvider: 'musicbrainz', externalIds: [{ provider: 'musicbrainz', value: 'rel1' }] } as Partial<Media>,
    );
    http.expectOne((r) => r.url === '/api/requests/title-state').flush({ requested: false, wholeAlbumRequested: false, requestedRecordings: ['r3'] });
    await fixture.whenStable();
    fixture.detectChanges();
    const cells = [...el.querySelectorAll('[data-testid="track-status"]')].map((c) => c.firstElementChild?.getAttribute('data-testid') ?? c.firstElementChild?.className.split(' ')[0]);
    expect(cells).toEqual(['badge', 'track-request', 'track-requested']);
  });
});
