import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { CastService } from '../cast.service';
import { CastPlayerService } from '../cast-player.service';
import { CastPlaybackTarget } from '../cast-playback-target';
import { DeviceService } from '../device.service';
import { ClockService } from '../party/clock.service';
import { VoiceService } from '../party/voice.service';
import { PartyService } from '../party/party.service';
import { PlayerStateService } from '../player-state.service';
import { MediaService } from '../api/media.service';
import { PlayerSettingsService } from '../player-settings.service';
import { PlaybackSession } from '../playback/playback-session';
import { RemotePlaybackTarget } from '../remote-playback-target';
import { ToastService } from '../toast.service';
import { LocalPlaybackOutput, type LocalOutputHost } from '../../../features/player/local-playback-output';
import { PartySync, type PartyHost } from './party-sync';
import { PlaybackQueueService } from '../playback-queue.service';

function setup(opts: { canControl?: boolean; urlParty?: string; joined?: number; resumes?: boolean; film?: boolean; opens?: boolean } = {}) {
  const closed = new Subject<void>();
  const party = {
    active: signal(true),
    party: signal(opts.joined != null ? { id: opts.joined } : null),
    resume: vi.fn().mockResolvedValue(opts.resumes ?? true),
    live: signal<unknown>(null),
    canControl: signal(opts.canControl ?? true),
    isHost: signal(false),
    closed,
    leaveOrEnd: vi.fn().mockResolvedValue(true),
    sendIntent: vi.fn().mockResolvedValue(undefined),
    reportStatus: vi.fn(),
    leave: vi.fn(),
  };
  const cast = {
    isConnected: signal(false),
    isPaused: signal(true),
    buffering: signal(false),
    ended: signal(false),
    currentTime: signal(0),
    duration: signal(100),
    seek: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
  };
  const queue = {
    items: () =>
      opts.film
        ? []
        : [
            { mediaId: 1, mediaFileId: 10, episodeId: 100, title: '' },
            { mediaId: 1, mediaFileId: 11, episodeId: 101, title: '' },
          ],
    index: () => 0,
  };
  const openItem = vi.fn().mockResolvedValue(opts.opens ?? true);
  const toast = { info: vi.fn(), error: vi.fn() };
  const router = { navigate: vi.fn(), navigateByUrl: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      PartySync,
      PlayerStateService,
      { provide: PartyService, useValue: party },
      { provide: ClockService, useValue: { serverNow: () => Date.now(), rttMs: signal(0) } },
      { provide: PlaybackQueueService, useValue: queue },
      { provide: VoiceService, useValue: { duck: signal(false), othersSpeaking: signal(false), joined: signal(false) } },
      { provide: CastService, useValue: cast },
      { provide: CastPlayerService, useValue: { hasMedia: signal(true), mediaId: signal(1), episodeId: signal(undefined), availableQualities: signal([]) } },
      CastPlaybackTarget,
      { provide: RemotePlaybackTarget, useValue: { isConnected: signal(false) } },
      { provide: MediaService, useValue: {} },
      { provide: PlayerSettingsService, useValue: { settings: () => ({ autoPlayNext: false }) } },
      { provide: DeviceService, useValue: { tvPlatform: () => null, isTv: () => false } },
      { provide: ToastService, useValue: toast },
      { provide: Router, useValue: router },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ],
  });
  const ctl = TestBed.inject(PartySync);
  const state = TestBed.inject(PlayerStateService);
  const engine = { play: vi.fn(), pause: vi.fn(), seek: vi.fn(), paused: false, playbackRate: 1, currentTime: 0 };
  const host = {
    engine: () => engine as never,
    mediaId: () => 1,
    episodeId: () => undefined,
    seekTo: vi.fn(),
    pausePlayback: vi.fn().mockResolvedValue(undefined),
    showControls: vi.fn(),
    playLocal: vi.fn(),
    releasePlayback: vi.fn(),
    urlPartyId: () => Number(opts.urlParty ?? 0),
    openItem,
    position: () => 0,
    onBack: vi.fn(),
    release: vi.fn(),
    stepAside: vi.fn(),
    resume: vi.fn(),
  } as unknown as PartyHost & LocalOutputHost;
  const session = TestBed.inject(PlaybackSession);
  const detachLocal = session.attachLocal(new LocalPlaybackOutput(host, state));
  const detach = ctl.attach(host);
  return { closed, ctl, party, state, engine, host, queue, toast, cast, router, session, detachLocal, detach, openItem };
}

describe('PartySync user actions', () => {
  it('shows the controls when the party goes from playing to paused, whoever paused', () => {
    const { ctl, party, host } = setup();
    party.live.set({ state: 'playing' });
    TestBed.tick();
    expect(host.showControls).not.toHaveBeenCalled();
    party.live.set({ state: 'paused' });
    TestBed.tick();
    expect(host.showControls).toHaveBeenCalledTimes(1);
  });

  it('sends play/pause as intents and leaves the engine alone', () => {
    const { ctl, party, state, engine, host } = setup();
    party.live.set({ state: 'paused' });
    state.paused.set(true);
    state.startingPlayback.set(false);
    expect(ctl.togglePlay()).toBe(true);
    expect(party.sendIntent).toHaveBeenCalledWith('play');
    expect(engine.play).not.toHaveBeenCalled();
    expect(host.playLocal).not.toHaveBeenCalled();
  });

  it('turns a seek into an intent and releases the drag lock', () => {
    const { ctl, party, state, host } = setup();
    state.seekLocked.set(true);
    expect(ctl.seek(120)).toBe(true);
    expect(party.sendIntent).toHaveBeenCalledWith('seek', { position: 120 });
    expect(state.seekLocked()).toBe(false);
    expect(host.seekTo).not.toHaveBeenCalled();
  });

  it('does nothing and says why when the policy is host-only', () => {
    const { ctl, party, toast } = setup({ canControl: false });
    party.live.set({ state: 'paused' });
    ctl.togglePlay();
    expect(party.sendIntent).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalled();
  });

  it('sends a picked queue item as one setItem intent and does not navigate', async () => {
    const { ctl, party, router } = setup();
    await ctl.requestQueueItem(1);
    expect(party.sendIntent).toHaveBeenCalledWith('setItem', {
      item: { mediaId: 1, mediaFileId: 11, episodeId: 101 },
    });
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('ignores the playing item and refuses a pick without control', async () => {
    const { ctl, party, toast } = setup();
    await ctl.requestQueueItem(0);
    expect(party.sendIntent).not.toHaveBeenCalled();
    party.canControl.set(false);
    await ctl.requestQueueItem(1);
    expect(party.sendIntent).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalled();
  });

  it('lets the player act normally outside a party', () => {
    const { ctl, party } = setup();
    party.active.set(false);
    expect(ctl.togglePlay()).toBe(false);
    expect(ctl.seek(5)).toBe(false);
  });
});

describe('PartySync queue', () => {
  it('asks the server for the next and the previous item instead of picking one', async () => {
    const { ctl, party, router } = setup({ joined: 3 });
    await ctl.requestNext();
    await ctl.requestPrevious();
    expect(party.sendIntent.mock.calls).toEqual([['next'], ['previous']]);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('refuses next and previous without control', async () => {
    const { ctl, party, toast } = setup({ joined: 3, canControl: false });
    await ctl.requestNext();
    await ctl.requestPrevious();
    expect(party.sendIntent).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(2);
  });

  it('reports the end of an item and lets the server advance', async () => {
    const { ctl, party, state } = setup({ joined: 3 });
    party.isHost.set(true);
    state.ended.set(true);
    TestBed.tick();
    await Promise.resolve();
    expect(party.sendIntent.mock.calls).toEqual([['ended', { item: { mediaId: 1 } }]]);
  });

  it('leaves the answer on a film to the server', async () => {
    const { ctl, party } = setup({ joined: 3, film: true });
    await ctl.requestNext();
    await ctl.requestPrevious();
    expect(party.sendIntent.mock.calls).toEqual([['next'], ['previous']]);
  });

  it('closes the player and tells the group it is ready when the new item cannot be opened', async () => {
    const { party, state, host } = setup({ joined: 3, opens: false });
    state.videoStarted.set(true);
    party.live.set({ state: 'paused', item: { mediaId: 2, episodeId: null }, anchor: { position: 5, serverTimeMs: 0 } });
    TestBed.tick();
    await new Promise<void>((r) => setTimeout(r));
    expect(host.onBack).toHaveBeenCalled();
    expect(host.seekTo).not.toHaveBeenCalled();
    expect(party.reportStatus).toHaveBeenCalledWith('ready', 5);
    expect(party.leave).not.toHaveBeenCalled();
  });

  it('sends an item picked from the queue menu as setItem', async () => {
    const { ctl, party } = setup({ joined: 3 });
    await ctl.requestQueueItem(1);
    expect(party.sendIntent).toHaveBeenCalledWith('setItem', {
      item: { mediaId: 1, mediaFileId: 11, episodeId: 101 },
    });
  });
});

describe('PartySync resume from the URL', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r));

  it('joins the party named by a reloaded player URL', () => {
    const { ctl, party } = setup({ urlParty: '37' });
    expect(party.resume).toHaveBeenCalledWith(37);
  });

  it('does not join twice when the app already is in that party', () => {
    const { ctl, party } = setup({ urlParty: '37', joined: 37 });
    expect(party.resume).not.toHaveBeenCalled();
  });

  it('does nothing without the param', () => {
    const { ctl, party } = setup();
    expect(party.resume).not.toHaveBeenCalled();
  });

  it('toasts and drops the param when the party cannot be rejoined', async () => {
    const { ctl, toast, router } = setup({ urlParty: '37', resumes: false });
    await flush();
    expect(toast.error).toHaveBeenCalledWith('party.error_resume');
    expect(router.navigate).toHaveBeenCalledWith([], expect.objectContaining({ queryParams: { party: null }, replaceUrl: true }));
  });

  it('keeps the param after a successful join', async () => {
    const { ctl, toast, router } = setup({ urlParty: '37' });
    await flush();
    expect(toast.error).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });
});

describe('PartySync on a Cast session', () => {
  it('turns the overlay controls into intents and leaves the receiver alone', () => {
    const { ctl, party, cast } = setup();
    cast.isConnected.set(true);
    cast.isPaused.set(false);
    party.live.set({ state: 'playing' });
    expect(ctl.togglePlay()).toBe(true);
    expect(party.sendIntent).toHaveBeenCalledWith('pause');
    expect(cast.pause).not.toHaveBeenCalled();
  });

  it('holds a receiver inside the 1.5 s band and seeks it past that, never touching the rate', async () => {
    vi.useFakeTimers();
    const { ctl, party, cast, engine } = setup();
    cast.isConnected.set(true);
    cast.isPaused.set(false);
    const anchor = { position: 50, serverTimeMs: Date.now() };
    party.live.set({ state: 'playing', anchor, item: { mediaId: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    cast.seek.mockClear();
    const base = Date.now();
    const follow = async (ms: number, lead: number) => {
      for (let t = 0; t < ms; t += 1000) {
        cast.currentTime.set(50 + (Date.now() - base) / 1000 + lead);
        await vi.advanceTimersByTimeAsync(1000);
      }
    };
    await follow(16_000, 1.2);
    expect(cast.seek).not.toHaveBeenCalled();
    await follow(2000, 5);
    expect(cast.seek).toHaveBeenCalledTimes(1);
    cast.seek.mockClear();
    await follow(10_000, 5);
    expect(cast.seek).not.toHaveBeenCalled();
    expect(engine.playbackRate).toBe(1);
    vi.useRealTimers();
  });
});

describe('PartySync leaving', () => {
  it('lands on the Home when the host ends the party', () => {
    const { ctl, closed, router, host } = setup();
    closed.next();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/', { replaceUrl: true });
    expect(host.onBack).not.toHaveBeenCalled();
  });

  it('lands on the Home when a member leaves, and stays put when the host declines', async () => {
    const { ctl, party, router } = setup();
    await ctl.leave();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/', { replaceUrl: true });
    router.navigateByUrl.mockClear();
    party.leaveOrEnd.mockResolvedValue(false);
    await ctl.leave();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });
});

describe('PartySync outside the player', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r));
  const held = { state: 'paused', item: { mediaId: 1, episodeId: null }, anchor: { position: 5, serverTimeMs: 0 } };

  it('keeps the party when the player closes', async () => {
    const { party, detach, detachLocal } = setup({ joined: 3 });
    detachLocal();
    detach();
    TestBed.tick();
    await flush();
    expect(party.leave).not.toHaveBeenCalled();
    expect(party.leaveOrEnd).not.toHaveBeenCalled();
    expect(party.active()).toBe(true);
  });

  it('reports ready at the anchor when the output goes, so a waiting group is not held', async () => {
    const { party, detachLocal } = setup({ joined: 3 });
    party.live.set({ ...held, state: 'waiting' });
    TestBed.tick();
    await flush();
    party.reportStatus.mockClear();
    detachLocal();
    TestBed.tick();
    expect(party.reportStatus).toHaveBeenCalledWith('ready', 5);
  });

  it('answers a later waiting phase with ready while nothing plays', async () => {
    const { party, detachLocal } = setup({ joined: 3 });
    detachLocal();
    TestBed.tick();
    party.reportStatus.mockClear();
    party.live.set({ ...held, state: 'waiting', anchor: { position: 0, serverTimeMs: 0 } });
    TestBed.tick();
    await flush();
    expect(party.reportStatus).toHaveBeenCalledWith('ready', 0);
    party.reportStatus.mockClear();
    party.live.set({ ...held, state: 'paused' });
    TestBed.tick();
    await flush();
    expect(party.reportStatus).not.toHaveBeenCalled();
  });

  it('brings a reopened player to the live state', async () => {
    const { party, session, state, detachLocal, engine, host } = setup({ joined: 3 });
    detachLocal();
    party.live.set({ ...held, state: 'playing', anchor: { position: 50, serverTimeMs: Date.now() } });
    TestBed.tick();
    await flush();
    const reopened = { ...host, seekTo: vi.fn(), playLocal: vi.fn(), position: () => 0 } as unknown as LocalOutputHost;
    state.videoStarted.set(true);
    session.attachLocal(new LocalPlaybackOutput(reopened, state));
    TestBed.tick();
    await flush();
    expect(reopened.seekTo).toHaveBeenCalledWith(expect.closeTo(50, 0));
    expect(reopened.playLocal).toHaveBeenCalled();
    expect(engine.play).not.toHaveBeenCalled();
  });

  it('keeps a newer player registered when an older one tears down', () => {
    const { party, detach } = setup({ joined: 3 });
    const sync = TestBed.inject(PartySync);
    const newer = { engine: () => null, urlPartyId: () => 0, showControls: vi.fn(), releasePlayback: vi.fn(), onBack: vi.fn(), openItem: vi.fn() } as unknown as PartyHost;
    sync.attach(newer);
    detach();
    party.live.set({ ...held, state: 'playing' });
    TestBed.tick();
    party.live.set(held);
    TestBed.tick();
    expect(newer.showControls).toHaveBeenCalledTimes(1);
  });
});
