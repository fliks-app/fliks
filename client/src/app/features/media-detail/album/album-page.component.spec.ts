import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { HttpTestingController } from '@angular/common/http/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import type { Media } from '../../../core/services/api/media.service';
import type { AlbumDetail, Track } from '../../../core/services/api/music.models';
import { holdsPermission } from '../../../core/permissions';
import { AuthService } from '../../../core/services/auth.service';
import { DownloadProgressService } from '../../../core/services/download-progress.service';
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

function setup(tracks: Track[], perms: string[] = [], extra: Partial<Media> = {}, focus?: string, party: object = { active: () => false }) {
  const player = playerStub();
  TestBed.configureTestingModule({
    providers: bookSpecProviders(
      ...(focus ? [{ provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ track: focus }) } } }] : []),
      { provide: AudioPlayerService, useValue: player },
      { provide: PartyService, useValue: party },
      { provide: MusicDownloadsService, useValue: { available: () => true, itemIds: () => new Set<number>(), tracks: () => new Map(), progress: () => null, state: () => 'none', download: vi.fn(), remove: vi.fn() } },
      { provide: AuthService, useValue: { hasPermission: (p: string) => holdsPermission(perms, p), user: () => null, sessionEpoch: () => 0, isAuthenticated: () => false } },
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
    expect(rows[2]!.getAttribute('data-state')).toBe('unwanted');
    expect(rows[2]!.querySelector('button')!.classList.contains('opacity-50')).toBe(true);
    expect(rows[0]!.querySelector('button')!.classList.contains('opacity-50')).toBe(false);
  });

  it('scrolls to the track named in the query and tints it', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { fixture, el } = setup([track(1), track(2)], [], {}, '2');
    await fixture.whenStable();
    const rows = el.querySelectorAll('[data-testid="track"]');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(rows[1]!.classList.contains('bg-primary/20')).toBe(true);
    expect(rows[0]!.classList.contains('bg-primary/20')).toBe(false);
  });

  it('shows the version chip only when the group has several releases, and the other versions as cards', () => {
    const { el } = setup([track(1)]);
    expect(el.querySelector('[data-testid="version"]')!.textContent).toContain('Deluxe');
    const cards = [...el.querySelectorAll('[data-testid="versions"] app-media-card')];
    expect(cards).toHaveLength(2);
    expect(el.querySelector('[data-testid="versions"]')!.textContent).toContain('music.version_standard');
    expect(el.querySelector('[data-testid="versions"]')!.textContent).toContain('Live');
  });

  it('hides the version chip and the versions row for a release alone in its group', () => {
    const { el } = setup([track(1)], [], { album: { ...album([track(1)]), versions: [versions[0]!] } } as Partial<Media>);
    expect(el.querySelector('[data-testid="version"]')).toBeNull();
    expect(el.querySelector('[data-testid="versions"]')).toBeNull();
  });

  it('asks for an unwanted track from its row, and for the whole album at once, through album requests', () => {
    const { fixture, el } = setup([track(1), track(2, { hasFile: false, monitored: false, recordingId: 'r2' })], ['media.create'], {
      preferredProvider: 'musicbrainz', externalIds: [{ provider: 'musicbrainz', value: 'rel1' }],
    } as Partial<Media>);
    const add = vi.spyOn(fixture.componentInstance['addDialog']()!, 'add').mockResolvedValue(undefined as never);
    (el.querySelector('[data-testid="track-add"]') as HTMLButtonElement).click();
    expect(add).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'album', externalId: 'rel1', recording: { externalId: 'r2', albumExternalId: 'rel1' } }));
    (el.querySelector('[data-testid="want-all"]') as HTMLButtonElement).click();
    expect(add).toHaveBeenLastCalledWith(expect.not.objectContaining({ recording: expect.anything() }));
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

  it('gives a member of a party that takes turns no "play next"', () => {
    const turns = (isHost: boolean) => ({ active: () => true, party: () => ({ rotation: true }), isHost: () => isHost });
    const icons = (isHost: boolean) => {
      const { el } = setup([track(1)], [], {}, undefined, turns(isHost));
      (el.querySelector('[data-testid="track-menu"]') as HTMLButtonElement).click();
      return TestBed.inject(CardActionsService).actions()!.map((a) => a.icon);
    };
    expect(icons(false)).not.toContain('list-start');
    TestBed.resetTestingModule();
    expect(icons(true)).toContain('list-start');
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
          { provide: AuthService, useValue: { hasPermission: () => canEdit, user: () => null, sessionEpoch: () => 0, isAuthenticated: () => false } },
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
    expect(el.querySelectorAll('[data-testid="track"] .font-medium.text-primary').length).toBe(1);
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

  it('shows each track of a requester as owned, requestable or requested', async () => {
    const { fixture, http, el } = setup(
      [track(1), track(2, { hasFile: false, monitored: false, recordingId: 'r2' }), track(3, { hasFile: false, monitored: false, recordingId: 'r3' })],
      ['requests.create'],
      { preferredProvider: 'musicbrainz', externalIds: [{ provider: 'musicbrainz', value: 'rel1' }] } as Partial<Media>,
    );
    http.expectOne((r) => r.url === '/api/requests/title-state').flush({ requested: false, wholeAlbumRequested: false, requestedRecordings: ['r3'] });
    await fixture.whenStable();
    fixture.detectChanges();
    const cells = [...el.querySelectorAll('[data-testid="track-state"]')].map((c) => c.firstElementChild?.getAttribute('data-testid') ?? null);
    expect(cells).toEqual([null, 'track-add', 'track-wanted']);
  });

  it('draws a ring for a download covering the track and an alert for a failed search, which a requester sees as wanted', () => {
    const t = [track(1, { hasFile: false, monitored: true }), track(2, { hasFile: false, monitored: true, lastAttempt: 'failed' })];
    const first = setup(t, ['media.create']);
    TestBed.inject(DownloadProgressService).applyProgress({ mediaId: 9, mediaType: 'album' as never, downloads: [{ ref: 'a', progress: 0.4, dlspeed: 0, eta: 0, state: 'active', itemIds: [1] }] });
    first.fixture.detectChanges();
    const states = [...first.el.querySelectorAll('[data-testid="track"]')].map((r) => r.getAttribute('data-state'));
    expect(states).toEqual(['downloading', 'failed']);
    expect(first.el.querySelector('[data-testid="track-downloading"]')!.getAttribute('aria-valuenow')).toBe('40');
    expect(first.el.querySelector('[data-testid="album-progress"] progress')).not.toBeNull();
    TestBed.resetTestingModule();
    const user = setup(t, ['requests.create']);
    expect(user.el.querySelector('[data-testid="track-failed"]')).toBeNull();
    expect(user.el.querySelectorAll('[data-testid="track-wanted"]').length).toBe(2);
  });

  it('lists the files outside the release apart from the tracklist', () => {
    const { el } = setup([track(1), track(2, { orphaned: true })]);
    expect(el.querySelectorAll('[data-testid="track"]').length).toBe(2);
    expect(el.querySelectorAll('[data-testid="orphan-files"] [data-testid="track"]').length).toBe(1);
  });
});
