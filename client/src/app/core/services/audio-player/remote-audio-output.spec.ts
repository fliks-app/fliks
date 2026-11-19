import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MusicApiService } from '../api/music-api.service';
import { NowPlayingMetadataService, type NowPlayingMetadata } from '../playback/now-playing-metadata.service';
import { PlaybackSession } from '../playback/playback-session';
import { RemotePlaybackTarget } from '../remote-playback-target';
import { RemoteService } from '../remote.service';
import { SessionSyncService, type AccountSession } from '../session-sync.service';
import { FullPlayerState } from '../playback/full-player-state';
import type { MusicTrackRequest, Repeat } from './music-queue';
import { RemoteAudioOutput } from './remote-audio-output';

const track = (itemId: number): MusicTrackRequest => ({
  itemId,
  mediaId: 3,
  title: `Track ${itemId}`,
  artists: 'Artist',
  albumTitle: 'Album',
  coverUrl: '/c.jpg',
  durationSeconds: 200,
  gain: null,
  peak: null,
  albumGain: null,
  albumPeak: null,
});

function session(over: Partial<AccountSession> = {}): AccountSession {
  return {
    epoch: 1,
    item: { id: 12, mediaId: 3, episodeId: null, mediaFileId: 9, kind: 'album', family: 'audio', title: 'Track 12', subtitle: null, posterUrl: '/p.jpg' },
    owner: { targetId: 'pc#1', deviceName: 'Desk', formFactor: 'desktop' },
    state: 'playing',
    positionSeconds: 64,
    positionAt: '2026-01-01T00:00:00.000Z',
    playing: true,
    durationSeconds: 200,
    queue: { itemIds: [11, 12, 13], index: 1, shuffle: false, repeat: 'off' },
    ...over,
  };
}

async function setup(account: AccountSession | null, live = true, owned = false) {
  const sync = {
    session: signal(account),
    claimPending: signal(false),
    parked: signal(account?.state === 'parked'),
    playHere: vi.fn(),
    role: signal(owned ? 'owner' : account ? 'observer' : 'none'),
    liveReport: computed(() => (live ? { mediaFileId: 9, durationSeconds: 200 } : null)),
    positionNow: (s: AccountSession) => (live ? 70 : s.positionSeconds + (s.playing ? Math.max(0, (Date.now() - Date.parse(s.positionAt)) / 1000) : 0)),
    durationNow: (s: AccountSession) => (live ? 200 : (s.durationSeconds ?? 0)),
    isAudio: SessionSyncService.prototype.isAudio,
  };
  const primeTracks = vi.fn();
  const target = {
    isIdle: signal(!live), uiPaused: signal(false), position: signal(70), duration: signal(200), seek: vi.fn(),
    item: signal<{ mediaId: number; itemId?: number }>({ mediaId: 0 }),
  };
  const playback = { remoteFamily: signal<'audio' | 'video' | null>(null), nowPlaying: signal<Partial<NowPlayingMetadata> | null>(null) };
  const remote = {
    isRemoting: signal(false),
    targetQueue: signal<{ itemIds: number[]; index: number; shuffle: boolean; repeat: Repeat } | null>(null),
    selectedTargetId: signal<string | null>(null),
    observedTargetId: signal<string | null>('pc#1'),
    send: vi.fn(),
    sendCoalesced: vi.fn(),
    observedCan: vi.fn(() => true),
    targetState: signal<{ playbackRate?: number; stemMode?: 'guide'; vocalLevel?: number; pitch?: number; stemsAvailable?: boolean } | null>(null),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: SessionSyncService, useValue: sync },
      { provide: RemotePlaybackTarget, useValue: target },
      { provide: RemoteService, useValue: remote },
      { provide: PlaybackSession, useValue: playback },
      { provide: NowPlayingMetadataService, useValue: { primeTracks } },
      { provide: MusicApiService, useValue: { trackRequests: vi.fn(async (ids: number[]) => ids.map(track)) } },
    ],
  });
  const out = TestBed.inject(RemoteAudioOutput);
  TestBed.tick();
  await Promise.resolve();
  await Promise.resolve();
  TestBed.tick();
  return { out, sync, target, remote, playback, primeTracks };
}

/** Selects `tv#2`, which plays a track of another album than the account session's. */
async function select(ctx: Awaited<ReturnType<typeof setup>>, id = 'tv#2'): Promise<void> {
  ctx.remote.isRemoting.set(true);
  ctx.remote.selectedTargetId.set(id);
  ctx.remote.observedTargetId.set(id);
  ctx.remote.targetState.set({});
  ctx.target.item.set({ mediaId: 5, itemId: 50 });
  ctx.target.position.set(15);
  ctx.target.duration.set(180);
  ctx.playback.remoteFamily.set('audio');
  ctx.playback.nowPlaying.set({ title: 'Song', artist: 'Band', album: 'Record', posterUrl: '/r.jpg' });
  TestBed.tick();
  await Promise.resolve();
  await Promise.resolve();
}

describe('RemoteAudioOutput', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('reads the queue, the playing track and the transport of the other device', async () => {
    const { out } = await setup(session());
    expect(out.queue().map((t) => t.itemId)).toEqual([11, 12, 13]);
    expect(out.queueIndex()).toBe(1);
    expect(out.track()).toMatchObject({ itemId: 12, title: 'Track 12', artist: 'Artist', album: 'Album' });
    expect(out.playing()).toBe(true);
    expect(out.position()).toBe(70);
  });

  it('shows an album session by its track title, with no artist, until the rows load', () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: SessionSyncService, useValue: { session: signal(session({ item: { ...session().item, title: 'Album A', subtitle: 'Track A' } })), parked: signal(false), role: signal('observer'), liveReport: signal(null), isAudio: SessionSyncService.prototype.isAudio } },
        { provide: RemotePlaybackTarget, useValue: {} },
        { provide: RemoteService, useValue: { isRemoting: signal(false) } },
        { provide: PlaybackSession, useValue: {} },
        { provide: NowPlayingMetadataService, useValue: { primeTracks: vi.fn() } },
        { provide: MusicApiService, useValue: { trackRequests: () => new Promise(() => {}) } },
      ],
    });
    expect(TestBed.inject(RemoteAudioOutput).track()).toMatchObject({ title: 'Track A', artist: undefined });
  });

  it('has no track for a video session, which the video view shows', async () => {
    const { out } = await setup(session({ item: { ...session().item, kind: 'series', family: 'video', episodeId: 7 } }));
    expect(out.track()).toBeNull();
  });

  it('fetches no rows for a session this device owns', async () => {
    const { out, primeTracks } = await setup(session(), true, true);
    expect(out.queue()).toEqual([]);
    expect(primeTracks).not.toHaveBeenCalled();
  });

  it('still fills the queue of a session parked on this device', async () => {
    const { out } = await setup(session({ state: 'parked' }));
    expect(out.queue().length).toBe(3);
  });

  it('primes the metadata service with the rows it loads', async () => {
    const { primeTracks } = await setup(session());
    expect(primeTracks).toHaveBeenCalledWith([track(11), track(12), track(13)]);
  });

  it('keeps the same track through a report that changes only the transport', async () => {
    const { out, sync } = await setup(session());
    const before = out.track();
    sync.session.set(session({ queue: { itemIds: [11, 12, 13], index: 1, shuffle: true, repeat: 'all' } }));
    expect(out.track()).toBe(before);
    sync.session.set(session({ item: { ...session().item, id: 13 }, queue: { itemIds: [11, 12, 13], index: 2, shuffle: true, repeat: 'all' } }));
    expect(out.track()?.itemId).toBe(13);
  });

  it('shows the track a skip asked for until the owner reports, then follows the report', async () => {
    const { out, sync, remote } = await setup(session());
    out.next();
    expect(remote.send).toHaveBeenCalledWith('pc#1', { action: 'next' });
    expect(out.track()?.itemId).toBe(13);
    expect(out.neighbour(1)).toBeNull();
    sync.session.set(session({ item: { ...session().item, id: 11 }, queue: { itemIds: [11, 12, 13], index: 0, shuffle: false, repeat: 'off' } }));
    expect(out.track()?.itemId).toBe(11);
  });

  it('takes a parked session here on play instead of commanding a device that left', async () => {
    const { out, sync, remote } = await setup(session({ state: 'parked' }));
    out.toggle();
    expect(sync.playHere).toHaveBeenCalled();
    expect(remote.send).not.toHaveBeenCalled();
  });

  it('shows the session playing while this device claims it, not the old owner pausing on its way out', async () => {
    const { out, sync, target } = await setup(session());
    target.uiPaused.set(true);
    expect(out.uiPlaying()).toBe(false);
    sync.claimPending.set(true);
    expect(out.uiPlaying()).toBe(true);
  });

  it('reads the stored position and no playback while the session is parked', async () => {
    const { out } = await setup(session({ state: 'parked', playing: false }), false);
    expect(out.controllable()).toBe(false);
    expect(out.playing()).toBe(false);
    expect(out.position()).toBe(64);
    expect(out.duration()).toBe(200);
  });

  it('follows the stored anchor of a playing session while its owner has not reported', async () => {
    const at = new Date(Date.now() - 10_000).toISOString();
    const { out, sync } = await setup(session({ positionAt: at }), false);
    expect(out.controllable()).toBe(true);
    expect(out.playing()).toBe(true);
    expect(out.position()).toBeGreaterThanOrEqual(74);
    expect(out.position()).toBeLessThan(76);
    sync.session.set(session({ positionAt: at, positionSeconds: 199, durationSeconds: 200 }));
    expect(out.position()).toBe(200);
  });

  it('sends every action to the observed target', async () => {
    const { out, remote, target } = await setup(session());
    out.toggle();
    out.next();
    out.previous();
    out.setShuffle(true);
    out.cycleRepeat();
    out.playQueueAt(2);
    out.seek(30);
    expect(remote.send.mock.calls.map((c) => c[1])).toEqual([
      { action: 'pause' },
      { action: 'next' },
      { action: 'prev' },
      { action: 'shuffle', shuffle: true },
      { action: 'repeat', repeat: 'all' },
      { action: 'queue', queue: { itemIds: [11, 12, 13], index: 2 } },
    ]);
    expect(remote.send.mock.calls.every((c) => c[0] === 'pc#1')).toBe(true);
    expect(target.seek).toHaveBeenCalledWith(30);
  });

  it('names a queue pick by its wire index when a track has no row', async () => {
    const { out, remote } = await setup(session({ queue: { itemIds: [11, 99, 13], index: 0, shuffle: false, repeat: 'off' } }));
    expect(out.queue().map((t) => t.itemId)).toEqual([11, 99, 13]);
    out.playQueueAt(2);
    expect(remote.send).toHaveBeenCalledWith('pc#1', { action: 'queue', queue: { itemIds: [11, 99, 13], index: 2 } });
  });

  it('closes its view when the session ends', async () => {
    const { out, sync } = await setup(session());
    out.expand();
    TestBed.tick();
    expect(out.expanded()).toBe(true);
    out.expand();
    sync.role.set('observer');
    sync.session.set(null);
    TestBed.tick();
    expect(out.expanded()).toBe(false);
  });

  it('hands its open view back to the local player when the session comes back to this device', async () => {
    const { out, sync } = await setup(session());
    out.expand();
    TestBed.tick();
    expect(out.expanded()).toBe(true);
    sync.role.set('owner');
    TestBed.tick();
    expect(out.expanded()).toBe(false);
    expect(TestBed.inject(FullPlayerState).open()).toBe('audio');
  });

  it('keeps its view while this device yields and still reads as owner, until the session comes back', async () => {
    const { out, sync } = await setup(session());
    sync.role.set('owner');
    TestBed.tick();
    TestBed.inject(FullPlayerState).show('audio', true);
    TestBed.tick();
    expect(out.expanded()).toBe(true);
    sync.role.set('observer');
    TestBed.tick();
    expect(out.expanded()).toBe(true);
    sync.role.set('owner');
    TestBed.tick();
    expect(out.expanded()).toBe(false);
  });

  it('reads the stem mix and key of the owner and sends them as karaoke commands', async () => {
    const { out, remote } = await setup(session());
    expect([out.stemMode(), out.vocalLevel(), out.pitch(), out.stemsAvailable()]).toEqual(['original', 0, 0, false]);
    remote.targetState.set({ stemMode: 'guide', vocalLevel: 0.4, pitch: -2, stemsAvailable: true });
    expect([out.stemMode(), out.vocalLevel(), out.pitch(), out.stemsAvailable()]).toEqual(['guide', 0.4, -2, true]);
    out.setStemMode('instrumental');
    out.setPitch(20);
    out.setVocalLevel(0.6);
    expect(remote.send).toHaveBeenNthCalledWith(1, 'pc#1', { action: 'karaoke', stemMode: 'instrumental' });
    expect(remote.send).toHaveBeenNthCalledWith(2, 'pc#1', { action: 'karaoke', pitch: 12 });
    expect(remote.sendCoalesced).toHaveBeenCalledWith('pc#1', { action: 'karaoke', level: 0.6 });
    expect(out.supports('karaoke')).toBe(true);
    remote.observedCan.mockReturnValue(false);
    expect(out.supports('karaoke')).toBe(false);
  });

  it('reads the playback rate of the owner while it reports', async () => {
    const { out, remote } = await setup(session());
    expect(out.rate()).toBe(1);
    remote.targetState.set({ playbackRate: 1.5 });
    expect(out.rate()).toBe(1.5);
  });

  describe('on a selected device', () => {
    it('reads the queue, shuffle and repeat the device reports, and drives them', async () => {
      const ctx = await setup(session());
      await select(ctx);
      const { out, remote } = ctx;
      remote.targetQueue.set({ itemIds: [49, 50, 51], index: 1, shuffle: true, repeat: 'all' });
      TestBed.tick();
      await Promise.resolve();
      await Promise.resolve();
      expect(out.queue().map((t) => t.itemId)).toEqual([49, 50, 51]);
      expect([out.queueIndex(), out.shuffle(), out.repeat()]).toEqual([1, true, 'all']);
      out.next();
      expect(out.track()?.itemId).toBe(51);
      out.playQueueAt(0);
      out.setShuffle(false);
      out.cycleRepeat();
      expect(remote.send.mock.calls).toEqual([
        ['tv#2', { action: 'next' }],
        ['tv#2', { action: 'queue', queue: { itemIds: [49, 50, 51], index: 0 } }],
        ['tv#2', { action: 'shuffle', shuffle: false }],
        ['tv#2', { action: 'repeat', repeat: 'one' }],
      ]);
    });

    it('keeps reading the account session queue for an observed owner, whatever the frame reports', async () => {
      const { out, remote } = await setup(session());
      remote.targetQueue.set({ itemIds: [49, 50, 51], index: 2, shuffle: true, repeat: 'one' });
      TestBed.tick();
      expect(out.queue().map((t) => t.itemId)).toEqual([11, 12, 13]);
      expect([out.queueIndex(), out.shuffle(), out.repeat()]).toEqual([1, false, 'off']);
    });

    it('reads the own report of the device instead of the account session, which it plays outside of', async () => {
      const ctx = await setup(session({ state: 'parked' }));
      await select(ctx);
      const { out, target, remote } = ctx;
      expect(out.track()).toEqual({ mediaId: 5, itemId: 50, title: 'Song', artist: 'Band', album: 'Record', coverUrl: '/r.jpg' });
      expect(out.queue()).toEqual([]);
      expect([out.position(), out.duration(), out.playing()]).toEqual([15, 180, true]);
      expect([out.parked(), out.controllable()]).toEqual([false, true]);
      target.uiPaused.set(true);
      expect(out.playing()).toBe(false);
      out.toggle();
      out.next();
      expect(remote.send.mock.calls).toEqual([['tv#2', { action: 'play' }], ['tv#2', { action: 'next' }]]);
    });

    it('keeps its track through the gap between two of its tracks, not past another selection', async () => {
      const ctx = await setup(null);
      await select(ctx);
      const { out, remote, playback } = ctx;
      expect(out.track()?.title).toBe('Song');
      remote.targetState.set(null);
      playback.nowPlaying.set(null);
      playback.remoteFamily.set(null);
      expect(out.track()?.title).toBe('Song');
      remote.selectedTargetId.set('tv#3');
      expect(out.track()).toBeNull();
    });

    it('keeps its view open without an account session, and closes it with the selection', async () => {
      const ctx = await setup(null);
      await select(ctx);
      ctx.out.expand();
      TestBed.tick();
      expect(ctx.out.expanded()).toBe(true);
      ctx.remote.isRemoting.set(false);
      TestBed.tick();
      expect(ctx.out.expanded()).toBe(false);
    });
  });
});
