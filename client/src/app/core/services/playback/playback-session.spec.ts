import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaService } from '../api/media.service';
import { MusicApiService } from '../api/music-api.service';
import { StreamingApiService } from '../api/streaming-api.service';
import { AudioPlayerService } from '../audio-player/audio-player.service';
import { MusicCastOutput } from '../audio-player/music-cast-output';
import { CastPlaybackTarget } from '../cast-playback-target';
import { CastPlayerService } from '../cast-player.service';
import { CastService } from '../cast.service';
import { DeviceService } from '../device.service';
import { PartyService } from '../party/party.service';
import { RemotePlaybackTarget } from '../remote-playback-target';
import { RemoteService } from '../remote.service';
import { SessionSyncService } from '../session-sync.service';
import { ToastService } from '../toast.service';
import type { LocalOutput, MusicSnapshot, PlaybackSnapshot, VideoHandoff } from './playback-output';
import { FullPlayerState } from './full-player-state';
import { PlaybackSession } from './playback-session';

function target() {
  const t = {
    isConnected: signal(false),
    isObserving: signal(false),
    item: vi.fn(() => ({ mediaId: 0, episodeId: undefined as number | undefined })),
    togglePlayPause: vi.fn(),
    seek: vi.fn(),
    playNext: vi.fn(),
    position: vi.fn(() => 42),
    paused: vi.fn(() => false),
    play: vi.fn(),
    pause: vi.fn(async () => {}),
    stopPlayback: vi.fn(),
    disconnect: vi.fn(),
    activeAudioTrackId: vi.fn(() => 'audio-2' as string | null),
    activeSubtitleId: vi.fn(() => 'sub-5' as string | null),
    snapshot: vi.fn((): PlaybackSnapshot | null => {
      const { mediaId, episodeId } = t.item();
      if (!mediaId) return null;
      return {
        item: { fileId: 7, mediaId, episodeId },
        position: t.position(),
        paused: t.paused(),
        tracks: { fileId: 7, audioStreamIndex: 2, subtitleId: t.activeSubtitleId() },
      };
    }),
  };
  return t;
}

function handoff(over: Partial<VideoHandoff> = {}): VideoHandoff {
  return {
    kind: 'video',
    snapshot: {
      item: { fileId: 7, mediaId: 3, episodeId: 9 },
      position: 120,
      paused: false,
      tracks: { fileId: 7, audioStreamIndex: 1, subtitleId: 'sub-2' },
    },
    resolveSubtitle: false,
    localSessionId: 'sid-local',
    cast: {
      mediaFileId: 7, mediaId: 3, episodeId: 9,
      playbackMode: 'transcode', subtitles: [], qualities: [], audioTracks: [],
      activeQualityId: '1080p', activeSubtitleId: 'sub-2', activeAudioStreamIndex: 1,
    } as VideoHandoff['cast'],
    ...over,
  };
}

function setup() {
  const cast = target();
  const remote = target();
  const party = { drives: signal(false), party: signal<{ id: number } | null>(null) };
  const castSvc = {
    isConnected: cast.isConnected,
    resumedState: signal<Record<string, unknown> | null>(null),
    settled: Promise.resolve(),
    connecting: signal(false),
    currentTime: vi.fn(() => 55),
    disconnect: vi.fn(),
    selectCastDevice: vi.fn(async () => {}),
    connectedDeviceId: signal<string | null>(null),
    requestSession: vi.fn(),
  };
  const remoteSvc = {
    isRemoting: remote.isConnected,
    selectedTargetId: signal<string | null>(null),
    liveOwner: signal<string | null>(null),
    /** Kinds the account session covers; null = all. */
    scope: signal<string[] | null>(null),
    playTarget: (kind: string) => remoteSvc.selectedTargetId() ?? (!remoteSvc.scope() || remoteSvc.scope()!.includes(kind) ? remoteSvc.liveOwner() : null),
    observedTargetId: () => remoteSvc.selectedTargetId() ?? 'tv-1',
    targetState: signal<{ mediaFileId: number; mediaType?: string; mediaId?: number; itemId?: number } | null>({ mediaFileId: 7 }),
    selectTarget: vi.fn(),
    canLoad: vi.fn(() => true),
    send: vi.fn(async () => {}),
  };
  const castPlayer = {
    hasMedia: vi.fn(() => false),
    adopt: vi.fn(),
    reloading: vi.fn(() => false),
    mediaFileId: signal(0),
    startCast: vi.fn(),
    reloadCastStream: vi.fn(async () => {}),
    resolveStartSubtitle: vi.fn(async () => ({ id: 'auto' })),
    liveSessionId: vi.fn(() => 'sid-cast'),
    clear: vi.fn(),
    quickStart: vi.fn(async () => {}),
  };
  const syncSvc = {
    session: signal<any>(null),
    observedOwnerTargetId: signal<string | null>('tv-1'),
    observableOwner: signal<string | null>(null),
    claimPending: signal(false),
    claim: vi.fn(async (start: () => Promise<void> | void) => start()),
    canTransfer: signal(true),
    canPlayHere: signal(false),
    playHere: vi.fn(async () => {}),
    parked: () => false,
    role: signal('owner'),
    transferTo: vi.fn(async (_id: string) => {}),
    isReading: (s: any) => s.item.family === 'text',
    isAudio: (s: any) => s.item.family === 'audio',
    videoItem: SessionSyncService.prototype.videoItem,
  };
  const device = { isTv: signal(false) };
  const audio = {
    holds: vi.fn(() => false), release: vi.fn(async (): Promise<unknown> => null), stepAside: vi.fn(), resume: vi.fn(async (_s: MusicSnapshot) => {}),
    loadFromRemote: vi.fn(async (_cmd: object) => true),
  };
  const musicCast = { hasMedia: signal(false), active: signal(false), snapshot: vi.fn((): MusicSnapshot | null => null), start: vi.fn(async (_h: unknown) => {}), adopt: vi.fn() };
  const router = { navigate: vi.fn(async () => true), navigateByUrl: vi.fn(async () => true), url: '/' };
  const streaming = { stopSession: vi.fn(async () => {}) };
  const media = { id: 3, title: 'Show', logoUrl: '/logo.png', fanartUrl: '/f.jpg', seasons: [{ seasonNumber: 1, episodes: [{ id: 9, episodeNumber: 2, title: 'Pilot' }] }] };
  TestBed.configureTestingModule({
    providers: [
      { provide: CastPlaybackTarget, useValue: cast },
      { provide: RemotePlaybackTarget, useValue: remote },
      { provide: PartyService, useValue: party },
      { provide: SessionSyncService, useValue: syncSvc },
      { provide: CastService, useValue: castSvc },
      { provide: RemoteService, useValue: remoteSvc },
      { provide: CastPlayerService, useValue: castPlayer },
      { provide: AudioPlayerService, useValue: audio },
      { provide: MusicCastOutput, useValue: musicCast },
      { provide: DeviceService, useValue: device },
      { provide: Router, useValue: router },
      { provide: StreamingApiService, useValue: streaming },
      { provide: ToastService, useValue: { error: vi.fn() } },
      { provide: MediaService, useValue: { getOne: vi.fn(async () => media) } },
      { provide: MusicApiService, useValue: { trackRequests: vi.fn(async () => []) } },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ],
  });
  const session = TestBed.inject(PlaybackSession);
  const local = {
    id: 'local',
    item: vi.fn(() => ({ mediaId: 3, episodeId: 9 })),
    holds: vi.fn(() => true),
    release: vi.fn(async () => handoff()),
    snapshot: vi.fn(() => null),
    stepAside: vi.fn(),
    resume: vi.fn(async () => {}),
    disconnect: vi.fn(),
  } as unknown as LocalOutput;
  return { session, syncSvc, cast, remote, party, local, castSvc, remoteSvc, castPlayer, device, router, streaming, audio, musicCast };
}

describe('PlaybackSession', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('picks the remote target, then the cast receiver, then the local output', () => {
    const { session, cast, remote, local } = setup();
    expect(session.output()).toBeNull();
    session.attachLocal(local);
    expect(session.output()).toBe(local);
    cast.isConnected.set(true);
    expect(session.output()).toBe(cast);
    remote.isConnected.set(true);
    expect(session.output()).toBe(remote);
  });

  it('reads what another output plays from the metadata service, from its identity alone', async () => {
    const { session, cast, local } = setup();
    session.attachLocal(local);
    TestBed.tick();
    expect(session.nowPlaying()).toBeNull();
    cast.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
    cast.isConnected.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(session.nowPlaying()).toMatchObject({ title: 'Show', episodeLabel: 'S1:E2 - Pilot', logoUrl: '/logo.png' }));
  });

  it('detaches a local output only through its own disposer', () => {
    const { session, local } = setup();
    const other = { id: 'other' } as unknown as LocalOutput;
    const detachLocal = session.attachLocal(local);
    session.attachLocal(other);
    detachLocal();
    expect(session.output()).toBe(other);
  });

  it('sends a command to the receiver outside a party', () => {
    const { session, cast, local } = setup();
    session.attachLocal(local);
    cast.isConnected.set(true);
    expect(session.command({ type: 'toggle' })).toBe(true);
    expect(session.command({ type: 'seek', at: 30 })).toBe(true);
    expect(session.command({ type: 'next' })).toBe(true);
    expect(cast.togglePlayPause).toHaveBeenCalled();
    expect(cast.seek).toHaveBeenCalledWith(30);
    expect(cast.playNext).toHaveBeenCalled();
  });

  it('leaves a command to the local player when nothing else takes it', () => {
    const { session, local } = setup();
    session.attachLocal(local);
    expect(session.command({ type: 'toggle' })).toBe(false);
  });

  it('routes to the party while one is active, never to the receiver', () => {
    const { session, cast, party } = setup();
    cast.isConnected.set(true);
    const router = vi.fn(() => true);
    session.setPartyRouter(router);
    party.drives.set(true);
    expect(session.command({ type: 'seek', at: 5 })).toBe(true);
    expect(router).toHaveBeenCalledWith({ type: 'seek', at: 5 }, 'video');
    expect(cast.seek).not.toHaveBeenCalled();
    party.drives.set(false);
    session.command({ type: 'seek', at: 6 });
    expect(cast.seek).toHaveBeenCalledWith(6);
  });

  it('keeps a newer party router when an older one is disposed', () => {
    const { session, party } = setup();
    party.drives.set(true);
    const older = vi.fn(() => true);
    const newer = vi.fn(() => true);
    const disposeOlder = session.setPartyRouter(older);
    session.setPartyRouter(newer);
    disposeOlder();
    session.command({ type: 'next' });
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
  });

  it('answers an audio command only through toParty', () => {
    const { session, party } = setup();
    const router = vi.fn(() => true);
    session.setPartyRouter(router);
    expect(session.toParty({ type: 'drives' }, 'audio')).toBe(true);
    expect(router).toHaveBeenCalledWith({ type: 'drives' }, 'audio');
    party.drives.set(true);
    expect(session.command({ type: 'next' })).toBe(true);
    expect(router).toHaveBeenLastCalledWith({ type: 'next' }, 'video');
  });

  describe('rejoin after a restart', () => {
    it('adopts an untagged state as video before the route decides', async () => {
      const { session, castSvc, castPlayer } = setup();
      const state = { kind: 'video', mediaFileId: 7 };
      castSvc.resumedState.set(state);
      await session.rejoinCast();
      expect(castPlayer.adopt).toHaveBeenCalledWith(state);
    });

    it('adopts a resume event that arrives once connected', () => {
      const { castSvc, castPlayer, cast } = setup();
      cast.isConnected.set(true);
      TestBed.tick();
      castSvc.resumedState.set({ kind: 'video', mediaFileId: 7 });
      TestBed.tick();
      expect(castPlayer.adopt).toHaveBeenCalledTimes(1);
    });

    it('steps the local player aside when the rejoined receiver has media', () => {
      const { session, castSvc, castPlayer, cast, local } = setup();
      session.attachLocal(local);
      castPlayer.hasMedia.mockImplementation(() => castPlayer.adopt.mock.calls.length > 0);
      castSvc.resumedState.set({ kind: 'video', mediaFileId: 7 });
      cast.isConnected.set(true);
      TestBed.tick();
      expect(local.stepAside).toHaveBeenCalled();
      expect(local.release).not.toHaveBeenCalled();
    });
  });

  describe('music rejoin', () => {
    it('arms the music cast output with a music-tagged resumed state and steps the local player aside', () => {
      const { castSvc, cast, audio, musicCast, castPlayer } = setup();
      audio.holds.mockReturnValue(true);
      musicCast.adopt.mockImplementation(() => musicCast.hasMedia.set(true));
      const state = { kind: 'music', itemId: 4, mediaFileId: 40 };
      castSvc.resumedState.set(state);
      cast.isConnected.set(true);
      TestBed.tick();
      expect(musicCast.adopt).toHaveBeenCalledWith(state);
      expect(castPlayer.adopt).not.toHaveBeenCalled();
      expect(audio.stepAside).toHaveBeenCalled();
      expect(audio.release).not.toHaveBeenCalled();
    });
  });

  describe('moveTo', () => {
    it('hands the local item to a connected receiver and keeps the player route', async () => {
      const { session, cast, local, castPlayer, streaming } = setup();
      session.attachLocal(local);
      cast.isConnected.set(true);
      expect(await session.moveTo('cast')).toBe(true);
      expect(local.release).toHaveBeenCalledTimes(1);
      expect(castPlayer.startCast).toHaveBeenCalledWith(expect.objectContaining({ mediaFileId: 7, activeSubtitleId: 'sub-2', activeAudioStreamIndex: 1 }));
      expect(castPlayer.reloadCastStream).toHaveBeenCalledWith(120, true, '1080p');
      expect(streaming.stopSession).toHaveBeenCalledWith('sid-local');
      expect(local.disconnect).not.toHaveBeenCalled();
    });

    it('starts the receiver paused when the local player was paused', async () => {
      const { session, cast, local, castPlayer } = setup();
      vi.mocked(local.release).mockResolvedValue(handoff({ snapshot: { ...handoff().snapshot, paused: true } }));
      session.attachLocal(local);
      cast.isConnected.set(true);
      await session.moveTo('cast');
      expect(castPlayer.reloadCastStream).toHaveBeenCalledWith(120, false, '1080p');
    });

    it('sends the pause to a remote device when the local player was paused', async () => {
      const { session, local, remoteSvc } = setup();
      vi.mocked(local.release).mockResolvedValue(handoff({ snapshot: { ...handoff().snapshot, paused: true } }));
      session.attachLocal(local);
      await session.moveTo('remote', 'dev-9');
      expect(remoteSvc.send).toHaveBeenCalledWith('dev-9', expect.objectContaining({ action: 'load', paused: true }));
    });

    it('connects a picked device first, then hands off', async () => {
      const { session, cast, castSvc, local, castPlayer } = setup();
      session.attachLocal(local);
      castSvc.selectCastDevice.mockImplementation(async () => {
        castSvc.connecting.set(true);
        queueMicrotask(() => cast.isConnected.set(true));
      });
      const moved = session.moveTo('cast', 'dev-1');
      await vi.waitFor(() => {
        TestBed.tick();
        expect(castPlayer.reloadCastStream).toHaveBeenCalled();
      });
      expect(await moved).toBe(true);
      expect(castSvc.selectCastDevice).toHaveBeenCalledWith('dev-1');
    });

    it('resolves the receiver subtitle when the local pick may have been refused', async () => {
      const { session, cast, local, castPlayer } = setup();
      (local.release as ReturnType<typeof vi.fn>).mockResolvedValue(handoff({ resolveSubtitle: true }));
      session.attachLocal(local);
      cast.isConnected.set(true);
      await session.moveTo('cast');
      expect(castPlayer.startCast).toHaveBeenCalledWith(expect.objectContaining({ activeSubtitleId: 'auto' }));
    });

    it('sends the item to a remote device at the released position', async () => {
      const { session, local, remoteSvc, streaming } = setup();
      session.attachLocal(local);
      expect(await session.moveTo('remote', 'dev-9')).toBe(true);
      expect(streaming.stopSession).toHaveBeenCalledWith('sid-local');
      expect(remoteSvc.selectTarget).toHaveBeenCalledWith('dev-9');
      expect(remoteSvc.send).toHaveBeenCalledWith('dev-9', { action: 'load', mediaId: 3, mediaFileId: 7, episodeId: 9, positionSeconds: 120, trackId: 'audio-1', subtitleId: 'sub-2' });
      expect(local.disconnect).not.toHaveBeenCalled();
    });

    it('moves music to another device through the account-session transfer, video through a direct load', async () => {
      const { session, local, syncSvc, remoteSvc, audio } = setup();
      syncSvc.session.set({ owner: { targetId: 'me' }, state: 'playing', item: { mediaFileId: 70 } });
      audio.holds.mockReturnValue(true);
      expect(session.canMoveTo('remote', 'dev-9')).toBe(true);
      expect(await session.moveTo('remote', 'dev-9')).toBe(true);
      expect(syncSvc.transferTo).toHaveBeenCalledWith('dev-9');
      expect(remoteSvc.send).not.toHaveBeenCalled();
      syncSvc.transferTo.mockClear();
      session.attachLocal(local);
      expect(await session.moveTo('remote', 'dev-9')).toBe(true);
      expect(syncSvc.transferTo).not.toHaveBeenCalled();
      expect(remoteSvc.send).toHaveBeenCalled();
    });

    it('does not transfer to another face of the device that owns the session', () => {
      const { session, syncSvc, audio } = setup();
      syncSvc.session.set({ owner: { targetId: 'dev#native' }, state: 'playing', item: { mediaFileId: 70 } });
      audio.holds.mockReturnValue(true);
      expect(session.transfersTo('dev#tab')).toBe(false);
      expect(session.transfersTo('other#tab')).toBe(true);
    });

    it('does not transfer a party track, nor to the device that owns the session', async () => {
      const { session, syncSvc, audio } = setup();
      syncSvc.session.set({ owner: { targetId: 'dev-9' }, state: 'playing', item: { mediaFileId: 70 } });
      audio.holds.mockReturnValue(true);
      expect(session.transfersTo('dev-9')).toBe(false);
      expect(session.transfersTo('dev-8')).toBe(true);
      session.setPartyRouter(() => true);
      expect(session.transfersTo('dev-8')).toBe(false);
    });

    it('starts the account session on the receiver when nothing plays here', async () => {
      const { session, cast, castSvc, syncSvc } = setup();
      castSvc.selectCastDevice.mockImplementation(async () => cast.isConnected.set(true));
      syncSvc.canPlayHere.set(true);
      expect(await session.moveTo('cast', 'cc-1')).toBe(true);
      expect(syncSvc.playHere).toHaveBeenCalled();
    });

    it('leaves the account session where it is for a reading position or a receiver that plays it', async () => {
      const { session, cast, castSvc, syncSvc, castPlayer } = setup();
      castSvc.selectCastDevice.mockImplementation(async () => cast.isConnected.set(true));
      syncSvc.canPlayHere.set(true);
      syncSvc.canTransfer.set(false);
      await session.moveTo('cast', 'cc-1');
      syncSvc.canTransfer.set(true);
      castPlayer.hasMedia.mockReturnValue(true);
      await session.moveTo('cast', 'cc-1');
      expect(syncSvc.playHere).not.toHaveBeenCalled();
    });

    it('refuses on a TV', async () => {
      const { session, device, local, castSvc, remoteSvc } = setup();
      session.attachLocal(local);
      device.isTv.set(true);
      expect(await session.moveTo('cast', 'dev-1')).toBe(false);
      expect(await session.moveTo('remote', 'dev-9')).toBe(false);
      expect(castSvc.selectCastDevice).not.toHaveBeenCalled();
      expect(remoteSvc.send).not.toHaveBeenCalled();
      expect(local.release).not.toHaveBeenCalled();
    });

    it('reloads the engine at the receiver position when coming back', async () => {
      const { session, cast, local, castSvc, castPlayer } = setup();
      cast.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      castPlayer.hasMedia.mockReturnValue(true);
      session.attachLocal(local);
      cast.isConnected.set(true);
      TestBed.tick();
      expect(await session.moveTo('local')).toBe(true);
      expect(cast.disconnect).toHaveBeenCalled();
      expect(local.resume).toHaveBeenCalledWith(expect.objectContaining({ position: 42, paused: false }));
    });

    it('takes the playback back paused when the cast was paused', async () => {
      const { session, cast, local, castPlayer } = setup();
      cast.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      castPlayer.hasMedia.mockReturnValue(true);
      cast.paused.mockReturnValue(true);
      session.attachLocal(local);
      cast.isConnected.set(true);
      TestBed.tick();
      await session.moveTo('local');
      expect(local.resume).toHaveBeenCalledWith(expect.objectContaining({ position: 42, paused: true }));
    });

    it('stops the remote device before taking the playback back', async () => {
      const { session, remote, remoteSvc, local } = setup();
      remote.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      session.attachLocal(local);
      remote.isConnected.set(true);
      TestBed.tick();
      expect(await session.moveTo('local')).toBe(true);
      expect(remote.stopPlayback).toHaveBeenCalled();
      expect(remote.disconnect).toHaveBeenCalled();
      expect(local.resume).toHaveBeenCalledWith(expect.objectContaining({ position: 42, paused: false }));
    });

    it('takes the playback back where it was sent when the remote device never reported', async () => {
      const { session, remote, local } = setup();
      session.attachLocal(local);
      expect(await session.moveTo('remote', 'dev-9')).toBe(true);
      remote.isConnected.set(true);
      TestBed.tick();
      expect(await session.moveTo('local')).toBe(true);
      expect(local.resume).toHaveBeenCalledWith(expect.objectContaining({ position: 120 }));
    });

    it('takes the account session over from its owner instead of stopping it', async () => {
      const { session, remote, local, syncSvc } = setup();
      syncSvc.observableOwner.set('tv-1');
      remote.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      session.attachLocal(local);
      remote.isConnected.set(true);
      TestBed.tick();
      expect(await session.moveTo('local')).toBe(true);
      expect(remote.stopPlayback).not.toHaveBeenCalled();
      expect(remote.disconnect).toHaveBeenCalled();
      expect(syncSvc.claim).toHaveBeenCalled();
      expect(local.resume).toHaveBeenCalledWith(expect.objectContaining({ position: 42 }));
    });

    it('opens the player first when taking back with none mounted, then resumes once it attaches', async () => {
      const { session, remote, local, router } = setup();
      remote.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      remote.isConnected.set(true);
      TestBed.tick();
      session.takeBack();
      expect(router.navigate).toHaveBeenCalledWith(['/watch', 7], { queryParams: { mediaId: 3, episodeId: 9 } });
      session.attachLocal(local);
      await Promise.resolve();
      expect(remote.stopPlayback).toHaveBeenCalled();
      await vi.waitFor(() => expect(local.resume).toHaveBeenCalledWith(expect.objectContaining({ position: 42, paused: false })));
      expect(local.resume).toHaveBeenCalledTimes(1);
    });

    it('does not resume a local output that was detached when the receiver is lost', () => {
      const { session, remote, local } = setup();
      const detach = session.attachLocal(local);
      remote.isConnected.set(true);
      TestBed.tick();
      detach();
      remote.isConnected.set(false);
      TestBed.tick();
      expect(local.resume).not.toHaveBeenCalled();
    });

    it('releases an idle remote device when taking back with nothing to resume', () => {
      const { session, remote, remoteSvc, router } = setup();
      remote.isConnected.set(true);
      TestBed.tick();
      session.takeBack();
      expect(router.navigate).not.toHaveBeenCalled();
      expect(remoteSvc.selectTarget).toHaveBeenCalledWith(null);
    });
  });

  describe('moveTo between cast and remote', () => {
    const tracks = { fileId: 7, audioStreamIndex: 2, subtitleId: 'sub-5' };

    it('carries the remote item to the receiver without starting the engine', async () => {
      const { session, cast, remote, local, castSvc, castPlayer, remoteSvc } = setup();
      remote.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      session.attachLocal(local);
      remote.isConnected.set(true);
      TestBed.tick();
      castSvc.selectCastDevice.mockImplementation(async () => cast.isConnected.set(true));
      expect(await session.moveTo('cast', 'cc-1')).toBe(true);
      expect(remote.stopPlayback).toHaveBeenCalled();
      expect(remote.disconnect).toHaveBeenCalled();
      expect(castPlayer.quickStart).toHaveBeenCalledWith(
        expect.objectContaining({ mediaFileId: 7, mediaId: 3, episodeId: 9, startTime: 42, tracks, autoplay: true }),
      );
      expect(local.release).not.toHaveBeenCalled();
      remote.isConnected.set(false);
      TestBed.tick();
      expect(local.resume).not.toHaveBeenCalled();
      expect(remoteSvc.send).not.toHaveBeenCalled();
    });

    it('moves playback from one remote device to another and stops the first', async () => {
      const { session, remote, local, remoteSvc } = setup();
      remote.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      session.attachLocal(local);
      remoteSvc.selectedTargetId.set('pc-1');
      remote.isConnected.set(true);
      TestBed.tick();
      expect(await session.moveTo('remote', 'tv-2')).toBe(true);
      expect(remote.stopPlayback).toHaveBeenCalled();
      expect(remoteSvc.selectTarget).toHaveBeenCalledWith('tv-2');
      expect(remoteSvc.send).toHaveBeenCalledWith('tv-2', expect.objectContaining({ action: 'load', mediaFileId: 7, mediaId: 3, positionSeconds: 42 }));
      expect(local.release).not.toHaveBeenCalled();
    });

    it('moves playback from one receiver to another, leaving the first before connecting the second', async () => {
      const { session, cast, local, castSvc, castPlayer } = setup();
      cast.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      cast.isConnected.set(true);
      cast.disconnect.mockImplementation(() => cast.isConnected.set(false));
      castSvc.selectCastDevice.mockImplementation(async () => cast.isConnected.set(true));
      let connectedAtLoad = false;
      castPlayer.quickStart.mockImplementation(async () => void (connectedAtLoad = cast.isConnected()));
      castPlayer.mediaFileId.set(7);
      castPlayer.hasMedia.mockReturnValue(true);
      castSvc.connectedDeviceId.set('cc-1');
      session.attachLocal(local);
      TestBed.tick();
      expect(await session.moveTo('cast', 'cc-2')).toBe(true);
      expect(castSvc.selectCastDevice).toHaveBeenCalledWith('cc-2');
      expect(cast.disconnect.mock.invocationCallOrder[0]).toBeLessThan(castSvc.selectCastDevice.mock.invocationCallOrder[0]);
      expect(connectedAtLoad).toBe(true);
      expect(castPlayer.quickStart).toHaveBeenCalledWith(expect.objectContaining({ mediaFileId: 7 }));
    });

    it('loads the receiver paused when the remote device was paused', async () => {
      const { session, cast, remote, local, castSvc, castPlayer } = setup();
      remote.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      remote.paused.mockReturnValue(true);
      session.attachLocal(local);
      remote.isConnected.set(true);
      TestBed.tick();
      castSvc.selectCastDevice.mockImplementation(async () => cast.isConnected.set(true));
      await session.moveTo('cast', 'cc-1');
      expect(castPlayer.quickStart).toHaveBeenCalledWith(expect.objectContaining({ autoplay: false }));
    });

    it('sends the pause of the receiver to a remote device', async () => {
      const { session, cast, local, remoteSvc, castPlayer } = setup();
      cast.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      cast.paused.mockReturnValue(true);
      castPlayer.mediaFileId.set(7);
      castPlayer.hasMedia.mockReturnValue(true);
      session.attachLocal(local);
      cast.isConnected.set(true);
      TestBed.tick();
      await session.moveTo('remote', 'dev-9');
      expect(remoteSvc.send).toHaveBeenCalledWith('dev-9', expect.objectContaining({ paused: true }));
    });

    it('carries the receiver item to a remote device without starting the engine', async () => {
      const { session, cast, local, remoteSvc, castPlayer, remote } = setup();
      cast.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      castPlayer.mediaFileId.set(7);
      castPlayer.hasMedia.mockReturnValue(true);
      session.attachLocal(local);
      cast.isConnected.set(true);
      TestBed.tick();
      expect(await session.moveTo('remote', 'dev-9')).toBe(true);
      expect(remoteSvc.selectTarget).toHaveBeenCalledWith('dev-9');
      expect(remoteSvc.send).toHaveBeenCalledWith('dev-9', {
        action: 'load', mediaId: 3, mediaFileId: 7, episodeId: 9, positionSeconds: 42,
        trackId: 'audio-2', subtitleId: 'sub-5',
      });
      expect(cast.disconnect).toHaveBeenCalled();
      cast.isConnected.set(false);
      remote.isConnected.set(true);
      TestBed.tick();
      expect(local.resume).not.toHaveBeenCalled();
      expect(local.release).not.toHaveBeenCalled();
    });
  });

  describe('a connect nobody asked for', () => {
    it('hands the local item over when the receiver is empty', () => {
      const { session, cast, local } = setup();
      session.attachLocal(local);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      expect(local.release).toHaveBeenCalledTimes(1);
      expect(local.stepAside).not.toHaveBeenCalled();
    });

    it('pauses and mutes the local output, never reloading, when the receiver has media', () => {
      const { session, cast, local, castPlayer } = setup();
      castPlayer.hasMedia.mockReturnValue(true);
      session.attachLocal(local);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      expect(local.stepAside).toHaveBeenCalledTimes(1);
      expect(local.release).not.toHaveBeenCalled();
      expect(castPlayer.reloadCastStream).not.toHaveBeenCalled();
    });

    const musicSnapshot: MusicSnapshot = { track: { itemId: 1 } as MusicSnapshot['track'], position: 42, paused: false, karaoke: { mode: 'guide', level: 0.25 } };

    it('hands the playing music over when no video player is mounted', async () => {
      const { cast, audio, musicCast } = setup();
      audio.holds.mockReturnValue(true);
      const handoff = { kind: 'music', snapshot: musicSnapshot };
      audio.release.mockResolvedValue(handoff);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      await vi.waitFor(() => expect(musicCast.start).toHaveBeenCalledWith(handoff));
      expect(audio.stepAside).not.toHaveBeenCalled();
    });

    it('steps the music aside, never moving it, when the receiver has media', () => {
      const { session, cast, audio, castPlayer } = setup();
      audio.holds.mockReturnValue(true);
      castPlayer.hasMedia.mockReturnValue(true);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      expect(audio.stepAside).toHaveBeenCalledTimes(1);
      expect(audio.release).not.toHaveBeenCalled();
      expect(session.kind()).toBe('cast');
    });

    it('steps the music aside when the receiver already plays music', () => {
      const { cast, audio, musicCast } = setup();
      audio.holds.mockReturnValue(true);
      musicCast.hasMedia.set(true);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      expect(audio.stepAside).toHaveBeenCalledTimes(1);
      expect(audio.release).not.toHaveBeenCalled();
    });

    it('leaves an audiobook playing here when an empty receiver connects', async () => {
      const { cast, audio, musicCast } = setup();
      audio.holds.mockReturnValue(true);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      await vi.waitFor(() => expect(audio.release).toHaveBeenCalledTimes(1));
      expect(musicCast.start).not.toHaveBeenCalled();
      expect(audio.stepAside).not.toHaveBeenCalled();
    });

    it('leaves a player still loading alone', () => {
      const { session, cast, local } = setup();
      (local.holds as ReturnType<typeof vi.fn>).mockReturnValue(false);
      session.attachLocal(local);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      expect(local.release).not.toHaveBeenCalled();
      expect(local.stepAside).not.toHaveBeenCalled();
    });

    it('sends a video hand-over to the video cast output, not the music one', async () => {
      const { session, cast, local, castPlayer, musicCast } = setup();
      cast.isConnected.set(true);
      session.attachLocal(local);
      await session.moveTo('cast');
      expect(castPlayer.startCast).toHaveBeenCalledTimes(1);
      expect(musicCast.start).not.toHaveBeenCalled();
    });

    it('resumes the music where the receiver was when the cast session ends', async () => {
      const { cast, audio, musicCast } = setup();
      audio.holds.mockReturnValue(true);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      await vi.waitFor(() => expect(audio.release).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r));
      musicCast.hasMedia.set(true);
      musicCast.active.set(true);
      musicCast.snapshot.mockReturnValue(musicSnapshot);
      TestBed.tick();
      cast.isConnected.set(false);
      TestBed.tick();
      expect(audio.resume).toHaveBeenCalledWith(musicSnapshot);
    });

    it('does not resume music that was closed while casting', async () => {
      const { cast, audio, musicCast } = setup();
      audio.holds.mockReturnValue(true);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      await vi.waitFor(() => expect(audio.release).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r));
      musicCast.hasMedia.set(true);
      musicCast.active.set(true);
      musicCast.snapshot.mockReturnValue(musicSnapshot);
      TestBed.tick();
      musicCast.hasMedia.set(false);
      musicCast.active.set(false);
      TestBed.tick();
      cast.isConnected.set(false);
      TestBed.tick();
      expect(audio.resume).not.toHaveBeenCalled();
    });

    it('resumes the engine at the receiver position when the session ends', () => {
      const { session, cast, local, castPlayer } = setup();
      cast.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      castPlayer.hasMedia.mockReturnValue(true);
      session.attachLocal(local);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      cast.isConnected.set(false);
      TestBed.tick();
      expect(local.resume).toHaveBeenCalledWith(expect.objectContaining({ position: 42, paused: false }));
    });

    it('resumes nothing here when the receiver goes once another device owns the session', () => {
      const { session, cast, local, castPlayer, syncSvc } = setup();
      cast.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      castPlayer.hasMedia.mockReturnValue(true);
      session.attachLocal(local);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      syncSvc.observableOwner.set('tv-1');
      cast.isConnected.set(false);
      TestBed.tick();
      expect(local.resume).not.toHaveBeenCalled();
    });

    it('resumes a video here when an armed music state never matched the receiver', () => {
      const { session, cast, local, castPlayer, musicCast } = setup();
      cast.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      castPlayer.hasMedia.mockReturnValue(true);
      musicCast.hasMedia.set(true);
      session.attachLocal(local);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      cast.isConnected.set(false);
      TestBed.tick();
      expect(local.resume).toHaveBeenCalledWith(expect.objectContaining({ position: 42, paused: false }));
    });

    it('resumes paused when the receiver was paused as the session ends', () => {
      const { session, cast, local, castPlayer } = setup();
      cast.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      castPlayer.hasMedia.mockReturnValue(true);
      cast.paused.mockReturnValue(true);
      session.attachLocal(local);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      cast.isConnected.set(false);
      TestBed.tick();
      expect(local.resume).toHaveBeenCalledWith(expect.objectContaining({ position: 42, paused: true }));
    });

    it('resumes the engine where the remote device was when control stops outside moveTo', () => {
      const { session, remote, local } = setup();
      remote.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      session.attachLocal(local);
      TestBed.tick();
      remote.isConnected.set(true);
      TestBed.tick();
      remote.isConnected.set(false);
      TestBed.tick();
      expect(local.resume).toHaveBeenCalledWith(expect.objectContaining({ position: 42, paused: false }));
    });
  });

  describe('play', () => {
    const item = { fileId: 7, mediaId: 3, episodeId: 9 };

    it('loads the receiver paused when the item says so', async () => {
      const { session, cast, castPlayer } = setup();
      cast.isConnected.set(true);
      await session.play({ ...item, paused: true }, { expand: false });
      expect(castPlayer.quickStart).toHaveBeenCalledWith(expect.objectContaining({ autoplay: false }));
    });

    it('starts the receiver where the caller knows playback stopped', async () => {
      const { session, cast, castPlayer } = setup();
      cast.isConnected.set(true);
      await session.play({ ...item, positionSeconds: 30 }, { expand: false });
      expect(castPlayer.quickStart).toHaveBeenCalledWith(expect.objectContaining({ startTime: 30 }));
    });

    it('sends a play to the live owner of the session, opening no player here', async () => {
      const { session, remoteSvc, router } = setup();
      remoteSvc.liveOwner.set('tv-1');
      expect(session.playsHere(item)).toBe(false);
      expect(await session.play({ ...item, positionSeconds: 30 })).toBe('remote');
      expect(remoteSvc.send).toHaveBeenCalledWith('tv-1', expect.objectContaining({ action: 'load', mediaFileId: 7, positionSeconds: 30 }));
      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('plays a video here when the session scope leaves videos out', async () => {
      const { session, remoteSvc, router } = setup();
      remoteSvc.liveOwner.set('tv-1');
      remoteSvc.scope.set(['album']);
      expect(session.playsHere(item)).toBe(true);
      expect(await session.play(item)).toBe('local');
      expect(remoteSvc.send).not.toHaveBeenCalled();
      expect(router.navigate).toHaveBeenCalled();
    });

    it('reads an episode without its media as a series for the session scope', () => {
      const { session, remoteSvc } = setup();
      remoteSvc.liveOwner.set('tv-1');
      remoteSvc.scope.set(['series']);
      expect(session.playsHere({ ...item, episodeId: 3, media: undefined })).toBe(false);
      expect(session.playsHere({ ...item, episodeId: undefined, media: undefined })).toBe(true);
    });

    it('plays a party item here while another device owns the session', async () => {
      const { session, remoteSvc, router, party } = setup();
      remoteSvc.liveOwner.set('tv-1');
      party.drives.set(true);
      expect(session.playsHere(item)).toBe(true);
      expect(await session.play(item)).toBe('local');
      expect(remoteSvc.send).not.toHaveBeenCalled();
      expect(router.navigate).toHaveBeenCalledWith(['/watch', 7], expect.anything());
    });

    it('navigates to the player when playing locally', async () => {
      const { session, router, castPlayer } = setup();
      expect(await session.play(item, { fromStart: true, query: { playlistId: 4 } })).toBe('local');
      expect(router.navigate).toHaveBeenCalledWith(['/watch', 7], expect.objectContaining({ queryParams: { mediaId: 3, playlistId: 4, episodeId: 9, t: 0 } }));
      expect(castPlayer.quickStart).not.toHaveBeenCalled();
    });

    it('loads on the receiver, then opens the player on it', async () => {
      const { session, cast, router, castPlayer } = setup();
      cast.isConnected.set(true);
      expect(await session.play(item)).toBe('cast');
      expect(castPlayer.quickStart).toHaveBeenCalledWith(expect.objectContaining({ mediaFileId: 7 }));
      expect(router.navigate).toHaveBeenCalledWith(['/watch', 7], { queryParams: { mediaId: 3, episodeId: 9 } });
      expect(session.claimOpened(7)).toBe(true);
      expect(session.claimOpened(7)).toBe(false);
    });

    it('loads without opening the player when asked not to', async () => {
      const { session, cast, router } = setup();
      cast.isConnected.set(true);
      await session.play(item, { expand: false });
      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('sends a load to the remote device, which wins over a receiver', async () => {
      const { session, cast, remote, remoteSvc, router } = setup();
      cast.isConnected.set(true);
      remote.isConnected.set(true);
      remoteSvc.selectedTargetId.set('dev-9');
      expect(await session.play({ ...item, positionSeconds: 30 })).toBe('remote');
      expect(remoteSvc.send).toHaveBeenCalledWith('dev-9', expect.objectContaining({ action: 'load', mediaFileId: 7, positionSeconds: 30 }));
      expect(router.navigate).toHaveBeenCalledWith(['/watch', 7], expect.anything());
    });
  });

  describe('viewing the observed session', () => {
    it('resolves the remote output with no device selected, and goes back to local when the view ends', () => {
      const { session, remote, local, remoteSvc } = setup();
      session.attachLocal(local);
      TestBed.inject(FullPlayerState).show('video', true);
      remote.isObserving.set(true);
      expect(session.kind()).toBe('remote');
      expect(session.output()).toBe(remote);
      expect(remoteSvc.selectTarget).not.toHaveBeenCalled();
      session.endView();
      expect(session.kind()).toBe('local');
      expect(session.output()).toBe(local);
    });

    it('ignores an open audio player', () => {
      const { session } = setup();
      TestBed.inject(FullPlayerState).show('audio', true);
      expect(session.kind()).toBe('local');
    });

    it('sends nothing when the observed owner is gone', async () => {
      const { session, remote, remoteSvc } = setup();
      remoteSvc.observedTargetId = () => null as unknown as string;
      remote.isConnected.set(true);
      await session.play({ fileId: 7, mediaId: 3 });
      expect(remoteSvc.send).not.toHaveBeenCalled();
    });

    it('opens the player route without selecting the device', () => {
      const { session, router, remoteSvc } = setup();
      session.viewObserved({ fileId: 7, mediaId: 3, episodeId: 9 });
      expect(TestBed.inject(FullPlayerState).open()).toBe('video');
      expect(router.navigate).toHaveBeenCalled();
      expect(remoteSvc.selectTarget).not.toHaveBeenCalled();
    });
  });

  describe('a view follows the owner', () => {
    const item = (family: string, mediaFileId: number | null = 7) => ({ item: { family, mediaFileId, mediaId: 3, episodeId: 9 } });

    it('keeps a video view on another video item and ends it for audio, a reader or no owner', () => {
      const { session, syncSvc } = setup();
      TestBed.inject(FullPlayerState).show('video', true);
      syncSvc.session.set(item('video'));
      expect(session.viewEnd()).toBeNull();
      syncSvc.session.set(item('video', 8));
      expect(session.viewEnd()).toBeNull();
      syncSvc.session.set(item('audio'));
      expect(session.viewEnd()).toBe('audio');
      syncSvc.session.set(item('text'));
      expect(session.viewEnd()).toBe('none');
      syncSvc.session.set(item('video'));
      syncSvc.observedOwnerTargetId.set(null);
      expect(session.viewEnd()).toBe('none');
    });

    it('keeps the view while this device claims the session, whose load replaces it', () => {
      const { session, syncSvc } = setup();
      TestBed.inject(FullPlayerState).show('video', true);
      syncSvc.session.set(item('video'));
      syncSvc.observedOwnerTargetId.set(null);
      expect(session.viewEnd()).toBe('none');
      syncSvc.claimPending.set(true);
      expect(session.viewEnd()).toBeNull();
    });

    it('has no verdict outside a video view', () => {
      const { session, syncSvc } = setup();
      syncSvc.session.set(item('audio'));
      expect(session.viewEnd()).toBeNull();
    });

    it('opens the audio player on an audio hand-over', () => {
      const { session } = setup();
      const fp = TestBed.inject(FullPlayerState);
      fp.show('video', true);
      session.handOverView('audio');
      expect(fp.open()).toBe('audio');
      expect(fp.remote()).toBe(true);
    });

    it('moves an audio view to the video player when the owner plays a video', () => {
      const { syncSvc, router } = setup();
      const fp = TestBed.inject(FullPlayerState);
      fp.show('audio', true);
      syncSvc.session.set(item('video'));
      TestBed.tick();
      expect(fp.open()).toBe('video');
      expect(router.navigate).toHaveBeenCalledWith(['/watch', 7], expect.anything());
    });

    it('leaves a local audio player alone', () => {
      const { syncSvc } = setup();
      const fp = TestBed.inject(FullPlayerState);
      fp.show('audio', false);
      syncSvc.session.set(item('video'));
      TestBed.tick();
      expect(fp.open()).toBe('audio');
    });
  });

  describe('yieldToView', () => {
    it('unloads the engine, stops its stream and turns the open route into the view, without resuming it', async () => {
      const { session, remote, local, streaming, remoteSvc } = setup();
      session.attachLocal(local);
      session.beginRoute();
      TestBed.tick();
      expect(await session.yieldToView()).toBe(true);
      remote.isObserving.set(true);
      TestBed.tick();
      expect(streaming.stopSession).toHaveBeenCalledWith('sid-local');
      expect(session.kind()).toBe('remote');
      expect(local.resume).not.toHaveBeenCalled();
      expect(remoteSvc.selectTarget).not.toHaveBeenCalled();
    });

    it('refuses while a cast receiver is connected, and a second time once it is the view', async () => {
      const { session, cast, local } = setup();
      session.attachLocal(local);
      session.beginRoute();
      cast.isConnected.set(true);
      expect(await session.yieldToView()).toBe(false);
      cast.isConnected.set(false);
      expect(await session.yieldToView()).toBe(true);
      expect(await session.yieldToView()).toBe(false);
      expect(local.release).toHaveBeenCalledOnce();
    });

    it('goes back to local when this device takes the session again', async () => {
      const { session, remote, local } = setup();
      remote.item.mockReturnValue({ mediaId: 3, episodeId: undefined });
      session.attachLocal(local);
      session.beginRoute();
      await session.yieldToView();
      remote.isObserving.set(true);
      expect(session.kind()).toBe('remote');
      expect(await session.moveTo('local')).toBe(true);
      expect(session.kind()).toBe('local');
      expect(TestBed.inject(FullPlayerState).remote()).toBe(false);
      expect(local.resume).toHaveBeenCalledOnce();
    });

    it('goes back to local from a view opened on the observed session', async () => {
      const { session, remote, local } = setup();
      remote.item.mockReturnValue({ mediaId: 3, episodeId: undefined });
      session.attachLocal(local);
      session.viewObserved({ fileId: 7, mediaId: 3 });
      expect(session.kind()).toBe('remote');
      expect(await session.moveTo('local')).toBe(true);
      expect(session.kind()).toBe('local');
    });

    it('leaves an open audio player alone when the view ends', async () => {
      const { session, local } = setup();
      session.attachLocal(local);
      session.beginRoute();
      TestBed.inject(FullPlayerState).show('audio', false);
      expect(await session.yieldToView()).toBe(true);
      expect(TestBed.inject(FullPlayerState).open()).toBe('audio');
      session.endView();
      expect(TestBed.inject(FullPlayerState).open()).toBe('audio');
    });

    it('leaves the route alone when no engine was loaded', async () => {
      const { session, local } = setup();
      vi.mocked(local.release).mockResolvedValue(null);
      session.attachLocal(local);
      expect(await session.yieldToView()).toBe(false);
      expect(session.kind()).toBe('local');
    });
  });

  describe('a selected device that plays audio', () => {
    const album = { mediaFileId: 7, mediaType: 'album', mediaId: 3, itemId: 12 };

    it('is driven from the audio player: the bar opens it there and its video route hands over', () => {
      const { session, remote, remoteSvc, router } = setup();
      remote.isConnected.set(true);
      remoteSvc.targetState.set(album);
      expect(session.remoteFamily()).toBe('audio');
      expect(session.viewEnd()).toBe('audio');
      session.openPlayer();
      const fp = TestBed.inject(FullPlayerState);
      expect([fp.open(), fp.remote()]).toEqual(['audio', true]);
      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('keeps the video route for a device that plays a video or names no kind', () => {
      const { session, remote, remoteSvc, router } = setup();
      remote.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      remote.isConnected.set(true);
      expect(session.remoteFamily()).toBeNull();
      session.openPlayer();
      expect(router.navigate).toHaveBeenCalledWith(['/watch', 7], expect.anything());
      remoteSvc.targetState.set({ mediaFileId: 7, mediaType: 'series' });
      expect(session.remoteFamily()).toBe('video');
      expect(session.viewEnd()).toBeNull();
    });

    it('moves its audio view to the video route once it plays a video', () => {
      const { session, remote, remoteSvc, router } = setup();
      remote.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      remote.isConnected.set(true);
      remoteSvc.targetState.set(album);
      session.openPlayer();
      TestBed.tick();
      expect(router.navigate).not.toHaveBeenCalled();
      remoteSvc.targetState.set({ mediaFileId: 7, mediaType: 'movie' });
      TestBed.tick();
      expect(router.navigate).toHaveBeenCalledWith(['/watch', 7], expect.anything());
    });

    it('takes its track back into the audio player here, then lets the device go', async () => {
      const { session, remote, remoteSvc, audio, router } = setup();
      remote.isConnected.set(true);
      remoteSvc.targetState.set(album);
      const fp = TestBed.inject(FullPlayerState);
      fp.show('audio', true);
      session.takeBack();
      await vi.waitFor(() => expect(remote.disconnect).toHaveBeenCalled());
      expect(remote.pause).toHaveBeenCalled();
      expect(audio.loadFromRemote).toHaveBeenCalledWith({ kind: 'album', mediaId: 3, itemId: 12, positionSeconds: 42, paused: false });
      expect(remote.stopPlayback).toHaveBeenCalled();
      expect([fp.open(), fp.remote()]).toEqual(['audio', false]);
      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('plays the device on when its track cannot start here', async () => {
      const { session, remote, remoteSvc, audio } = setup();
      audio.loadFromRemote.mockResolvedValue(false);
      remote.isConnected.set(true);
      remoteSvc.targetState.set(album);
      session.takeBack();
      await vi.waitFor(() => expect(remote.play).toHaveBeenCalled());
      expect(remote.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('openPlayer', () => {
    it('opens the route on what the receiver plays, with the party', () => {
      const { session, cast, party, router, castPlayer } = setup();
      cast.isConnected.set(true);
      cast.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      castPlayer.mediaFileId.set(7);
      party.party.set({ id: 5 });
      party.drives.set(true);
      session.openPlayer();
      expect(router.navigate).toHaveBeenCalledWith(['/watch', 7], { queryParams: { mediaId: 3, episodeId: 9, party: 5 } });
    });

    it('leaves the party out of the route while it is only in its lobby', () => {
      const { session, cast, party, router, castPlayer } = setup();
      cast.isConnected.set(true);
      cast.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      castPlayer.mediaFileId.set(7);
      party.party.set({ id: 5 });
      session.openPlayer();
      expect(router.navigate).toHaveBeenCalledWith(['/watch', 7], { queryParams: { mediaId: 3, episodeId: 9 } });
    });

    it('does nothing while the output is idle or the player is already open', () => {
      const { session, cast, router, castPlayer } = setup();
      cast.isConnected.set(true);
      session.openPlayer();
      expect(router.navigate).not.toHaveBeenCalled();
      cast.item.mockReturnValue({ mediaId: 3, episodeId: 9 });
      castPlayer.mediaFileId.set(7);
      router.url = '/watch/7';
      session.openPlayer();
      expect(router.navigate).not.toHaveBeenCalled();
    });
  });
});
