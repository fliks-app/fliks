import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    togglePlayPause: vi.fn(),
    seek: vi.fn(),
    playNext: vi.fn(),
    position: vi.fn(() => 42),
  };
}

function handoff(over: Partial<LocalHandoff> = {}): LocalHandoff {
  return {
    position: 120,
    resolveSubtitle: false,
    localSessionId: 'sid-local',
    cast: {
      mediaFileId: 7, mediaId: 3, episodeId: 9, mediaTitle: 'T', episodeTitle: 'E', fanartUrl: null,
      playbackMode: 'transcode', subtitles: [], qualities: [], audioTracks: [],
      activeQualityId: '1080p', activeSubtitleId: 'sub-2', activeAudioStreamIndex: 1,
    } as LocalHandoff['cast'],
    ...over,
  };
}

function setup() {
  const cast = target();
  const remote = target();
  const party = { active: signal(false) };
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
    selectTarget: vi.fn(),
    send: vi.fn(async () => {}),
  };
  const castPlayer = {
    hasMedia: vi.fn(() => false),
    startCast: vi.fn(),
    reloadCastStream: vi.fn(async () => {}),
    resolveStartSubtitle: vi.fn(async () => ({ id: 'auto' })),
    liveSessionId: vi.fn(() => 'sid-cast'),
    clear: vi.fn(),
    quickStart: vi.fn(async () => {}),
  };
  const device = { isTv: signal(false) };
  const router = { navigate: vi.fn(async () => true) };
  const streaming = { stopSession: vi.fn(async () => {}) };
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
    party.active.set(true);
    expect(session.command({ type: 'seek', at: 5 })).toBe(true);
    expect(router).toHaveBeenCalledWith({ type: 'seek', at: 5 });
    expect(cast.seek).not.toHaveBeenCalled();
    party.active.set(false);
    session.command({ type: 'seek', at: 6 });
    expect(cast.seek).toHaveBeenCalledWith(6);
  });

  it('keeps a newer party router when an older one is disposed', () => {
    const { session, party } = setup();
    party.active.set(true);
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
    it('hands the local item to a connected receiver and leaves the player', async () => {
      const { session, cast, local, castPlayer, streaming } = setup();
      session.attachLocal(local);
      cast.isConnected.set(true);
      expect(await session.moveTo('cast')).toBe(true);
      expect(local.release).toHaveBeenCalledTimes(1);
      expect(castPlayer.startCast).toHaveBeenCalledWith(expect.objectContaining({ mediaFileId: 7, activeSubtitleId: 'sub-2', activeAudioStreamIndex: 1 }));
      expect(castPlayer.reloadCastStream).toHaveBeenCalledWith(120, true, '1080p');
      expect(streaming.stopSession).toHaveBeenCalledWith('sid-local');
      expect(session.expanded()).toBe(true);
      expect(local.disconnect).toHaveBeenCalled();
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
      const { session, local, remoteSvc } = setup();
      session.attachLocal(local);
      expect(await session.moveTo('remote', 'dev-9')).toBe(true);
      expect(remoteSvc.selectTarget).toHaveBeenCalledWith('dev-9');
      expect(remoteSvc.send).toHaveBeenCalledWith('dev-9', { action: 'load', mediaId: 3, mediaFileId: 7, episodeId: 9, positionSeconds: 120 });
      expect(local.disconnect).toHaveBeenCalled();
    });

    it('stays on the player route in a party', async () => {
      const { session, party, local, remoteSvc } = setup();
      session.attachLocal(local);
      party.active.set(true);
      await session.moveTo('remote', 'dev-9');
      expect(remoteSvc.send).toHaveBeenCalled();
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
      expect(local.resume).toHaveBeenCalledWith(42);
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
      expect(local.resume).toHaveBeenCalledWith(55);
    });
  });

  describe('play', () => {
    const item = { fileId: 7, mediaId: 3, episodeId: 9, title: 'T' };

    it('navigates to the player when playing locally', async () => {
      const { session, router, castPlayer } = setup();
      expect(await session.play(item, { fromStart: true, query: { playlistId: 4 } })).toBe('local');
      expect(router.navigate).toHaveBeenCalledWith(['/watch', 7], expect.objectContaining({ queryParams: { mediaId: 3, playlistId: 4, episodeId: 9, t: 0 } }));
      expect(castPlayer.quickStart).not.toHaveBeenCalled();
    });

    it('loads on the receiver without opening the player', async () => {
      const { session, cast, router, castPlayer } = setup();
      cast.isConnected.set(true);
      expect(await session.play(item)).toBe('cast');
      expect(castPlayer.quickStart).toHaveBeenCalledWith(expect.objectContaining({ mediaFileId: 7, expand: true }));
      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('sends a load to the remote device, which wins over a receiver', async () => {
      const { session, cast, remote, remoteSvc, router } = setup();
      cast.isConnected.set(true);
      remote.isConnected.set(true);
      remoteSvc.selectedTargetId.set('dev-9');
      expect(await session.play({ ...item, positionSeconds: 30 })).toBe('remote');
      expect(remoteSvc.send).toHaveBeenCalledWith('dev-9', expect.objectContaining({ action: 'load', mediaFileId: 7, positionSeconds: 30 }));
      expect(router.navigate).not.toHaveBeenCalled();
    });
  });
});
