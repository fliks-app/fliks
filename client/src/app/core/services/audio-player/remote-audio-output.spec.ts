import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MusicApiService } from '../api/music-api.service';
import { RemotePlaybackTarget } from '../remote-playback-target';
import { RemoteService } from '../remote.service';
import { SessionSyncService, type AccountSession } from '../session-sync.service';
import type { MusicTrackRequest } from './music-queue';
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
    item: { id: 12, mediaId: 3, episodeId: null, mediaFileId: null, kind: 'album', family: 'audio', title: 'Track 12', subtitle: null, posterUrl: '/p.jpg' },
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

async function setup(account: AccountSession | null, live = true) {
  const sync = { session: signal(account), parked: signal(account?.state === 'parked'), role: signal(account ? 'observer' : 'none') };
  const target = { isIdle: signal(!live), uiPaused: signal(false), position: signal(70), duration: signal(200), seek: vi.fn() };
  const remote = { observedTargetId: signal<string | null>('pc#1'), send: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: SessionSyncService, useValue: sync },
      { provide: RemotePlaybackTarget, useValue: target },
      { provide: RemoteService, useValue: remote },
      { provide: MusicApiService, useValue: { trackRequests: vi.fn(async (ids: number[]) => ids.map(track)) } },
    ],
  });
  const out = TestBed.inject(RemoteAudioOutput);
  TestBed.tick();
  await Promise.resolve();
  await Promise.resolve();
  TestBed.tick();
  return { out, sync, target, remote };
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

  it('reads the stored position and no playback while the session is parked', async () => {
    const { out } = await setup(session({ state: 'parked', playing: false }), false);
    expect(out.live()).toBe(false);
    expect(out.playing()).toBe(false);
    expect(out.position()).toBe(64);
    expect(out.duration()).toBe(200);
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

  it('closes its view when the session ends or this device takes it over', async () => {
    const { out, sync } = await setup(session());
    out.expand();
    TestBed.tick();
    expect(out.expanded()).toBe(true);
    sync.role.set('owner');
    TestBed.tick();
    expect(out.expanded()).toBe(false);
    out.expand();
    sync.role.set('observer');
    sync.session.set(null);
    TestBed.tick();
    expect(out.expanded()).toBe(false);
  });
});
