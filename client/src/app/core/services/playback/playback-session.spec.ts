import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaService } from '../api/media.service';
import { StreamingApiService } from '../api/streaming-api.service';
import { CastPlaybackTarget } from '../cast-playback-target';
import { CastPlayerService } from '../cast-player.service';
import { CastService } from '../cast.service';
import { DeviceService } from '../device.service';
import { PartyService } from '../party/party.service';
import { RemotePlaybackTarget } from '../remote-playback-target';
import { RemoteService } from '../remote.service';
import { ToastService } from '../toast.service';
import type { LocalHandoff, LocalOutput } from './playback-output';
import { PlaybackSession } from './playback-session';

function target() {
  return {
    isConnected: signal(false),
    item: vi.fn(() => ({ mediaId: 0, episodeId: undefined as number | undefined })),
    togglePlayPause: vi.fn(),
    seek: vi.fn(),
    playNext: vi.fn(),
    position: vi.fn(() => 42),
    paused: vi.fn(() => false),
    pause: vi.fn(async () => {}),
    stopPlayback: vi.fn(),
    disconnect: vi.fn(),
    activeAudioTrackId: vi.fn(() => 'audio-2' as string | null),
    activeSubtitleId: vi.fn(() => 'sub-5' as string | null),
  };
}

function handoff(over: Partial<LocalHandoff> = {}): LocalHandoff {
  return {
    position: 120,
    paused: false,
    resolveSubtitle: false,
    localSessionId: 'sid-local',
    cast: {
      mediaFileId: 7, mediaId: 3, episodeId: 9,
      playbackMode: 'transcode', subtitles: [], qualities: [], audioTracks: [],
      activeQualityId: '1080p', activeSubtitleId: 'sub-2', activeAudioStreamIndex: 1,
    } as LocalHandoff['cast'],
    ...over,
  };
}

function setup() {
  const cast = target();
  const remote = target();
  const party = { drives: signal(false), party: signal<{ id: number } | null>(null) };
  const castSvc = {
    isConnected: cast.isConnected,
    connecting: signal(false),
    currentTime: vi.fn(() => 55),
    disconnect: vi.fn(),
    selectCastDevice: vi.fn(async () => {}),
    requestSession: vi.fn(),
  };
  const remoteSvc = {
    isRemoting: remote.isConnected,
    selectedTargetId: signal<string | null>(null),
    targetState: signal<{ mediaFileId: number } | null>({ mediaFileId: 7 }),
    selectTarget: vi.fn(),
    send: vi.fn(async () => {}),
  };
  const castPlayer = {
    hasMedia: vi.fn(() => false),
    reloading: vi.fn(() => false),
    mediaFileId: signal(0),
    startCast: vi.fn(),
    reloadCastStream: vi.fn(async () => {}),
    resolveStartSubtitle: vi.fn(async () => ({ id: 'auto' })),
    liveSessionId: vi.fn(() => 'sid-cast'),
    clear: vi.fn(),
    quickStart: vi.fn(async () => {}),
  };
  const device = { isTv: signal(false) };
  const router = { navigate: vi.fn(async () => true), url: '/' };
  const streaming = { stopSession: vi.fn(async () => {}) };
  const media = { id: 3, title: 'Show', logoUrl: '/logo.png', fanartUrl: '/f.jpg', seasons: [{ seasonNumber: 1, episodes: [{ id: 9, episodeNumber: 2, title: 'Pilot' }] }] };
  TestBed.configureTestingModule({
    providers: [
      { provide: CastPlaybackTarget, useValue: cast },
      { provide: RemotePlaybackTarget, useValue: remote },
      { provide: PartyService, useValue: party },
      { provide: CastService, useValue: castSvc },
      { provide: RemoteService, useValue: remoteSvc },
      { provide: CastPlayerService, useValue: castPlayer },
      { provide: DeviceService, useValue: device },
      { provide: Router, useValue: router },
      { provide: StreamingApiService, useValue: streaming },
      { provide: ToastService, useValue: { error: vi.fn() } },
      { provide: MediaService, useValue: { getOne: vi.fn(async () => media) } },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ],
  });
  const session = TestBed.inject(PlaybackSession);
  const local = {
    id: 'local',
    item: vi.fn(() => ({ mediaId: 3, episodeId: 9 })),
    release: vi.fn(async () => handoff()),
    stepAside: vi.fn(),
    resume: vi.fn(async () => {}),
    disconnect: vi.fn(),
  } as unknown as LocalOutput;
  return { session, cast, remote, party, local, castSvc, remoteSvc, castPlayer, device, router, streaming };
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
    expect(router).toHaveBeenCalledWith({ type: 'seek', at: 5 });
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
      vi.mocked(local.release).mockResolvedValue(handoff({ paused: true }));
      session.attachLocal(local);
      cast.isConnected.set(true);
      await session.moveTo('cast');
      expect(castPlayer.reloadCastStream).toHaveBeenCalledWith(120, false, '1080p');
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
      expect(remoteSvc.send).toHaveBeenCalledWith('dev-9', { action: 'load', mediaId: 3, mediaFileId: 7, episodeId: 9, positionSeconds: 120 });
      expect(local.disconnect).not.toHaveBeenCalled();
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
      castPlayer.hasMedia.mockReturnValue(true);
      session.attachLocal(local);
      cast.isConnected.set(true);
      TestBed.tick();
      expect(await session.moveTo('local')).toBe(true);
      expect(castSvc.disconnect).toHaveBeenCalled();
      expect(local.resume).toHaveBeenCalledWith(42, false);
    });

    it('takes the playback back paused when the cast was paused', async () => {
      const { session, cast, local, castPlayer } = setup();
      castPlayer.hasMedia.mockReturnValue(true);
      cast.paused.mockReturnValue(true);
      session.attachLocal(local);
      cast.isConnected.set(true);
      TestBed.tick();
      await session.moveTo('local');
      expect(local.resume).toHaveBeenCalledWith(42, true);
    });

    it('stops the remote device before taking the playback back', async () => {
      const { session, remote, remoteSvc, local } = setup();
      session.attachLocal(local);
      remote.isConnected.set(true);
      TestBed.tick();
      expect(await session.moveTo('local')).toBe(true);
      expect(remote.stopPlayback).toHaveBeenCalled();
      expect(remoteSvc.selectTarget).toHaveBeenCalledWith(null);
      expect(local.resume).toHaveBeenCalledWith(42, false);
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
      await vi.waitFor(() => expect(local.resume).toHaveBeenCalledWith(42, false));
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

    it('lets the remote device play on alone when control stops, without resuming here', () => {
      const { session, remote, remoteSvc, local } = setup();
      session.attachLocal(local);
      remote.isConnected.set(true);
      TestBed.tick();
      session.stopControlling();
      remote.isConnected.set(false);
      TestBed.tick();
      expect(remote.stopPlayback).not.toHaveBeenCalled();
      expect(remoteSvc.selectTarget).toHaveBeenCalledWith(null);
      expect(local.disconnect).toHaveBeenCalled();
      expect(local.resume).not.toHaveBeenCalled();
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
      expect(remote.pause).toHaveBeenCalled();
      expect(remote.disconnect).toHaveBeenCalled();
      expect(castPlayer.quickStart).toHaveBeenCalledWith(
        expect.objectContaining({ mediaFileId: 7, mediaId: 3, episodeId: 9, startTime: 42, tracks }),
      );
      expect(local.release).not.toHaveBeenCalled();
      remote.isConnected.set(false);
      TestBed.tick();
      expect(local.resume).not.toHaveBeenCalled();
      expect(remoteSvc.send).not.toHaveBeenCalled();
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

    it('resumes the engine at the receiver position when the session ends', () => {
      const { session, cast, local, castPlayer } = setup();
      castPlayer.hasMedia.mockReturnValue(true);
      session.attachLocal(local);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      cast.isConnected.set(false);
      TestBed.tick();
      expect(local.resume).toHaveBeenCalledWith(42, false);
    });

    it('resumes paused when the receiver was paused as the session ends', () => {
      const { session, cast, local, castPlayer } = setup();
      castPlayer.hasMedia.mockReturnValue(true);
      cast.paused.mockReturnValue(true);
      session.attachLocal(local);
      TestBed.tick();
      cast.isConnected.set(true);
      TestBed.tick();
      cast.isConnected.set(false);
      TestBed.tick();
      expect(local.resume).toHaveBeenCalledWith(42, true);
    });

    it('resumes the engine where the remote device was when control stops outside moveTo', () => {
      const { session, remote, local } = setup();
      session.attachLocal(local);
      TestBed.tick();
      remote.isConnected.set(true);
      TestBed.tick();
      remote.isConnected.set(false);
      TestBed.tick();
      expect(local.resume).toHaveBeenCalledWith(42, false);
    });
  });

  describe('play', () => {
    const item = { fileId: 7, mediaId: 3, episodeId: 9 };

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
