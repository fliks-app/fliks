import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { CastService } from '../../core/services/cast.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { CastPlaybackTarget } from '../../core/services/cast-playback-target';
import { DeviceService } from '../../core/services/device.service';
import { ClockService } from '../../core/services/party/clock.service';
import { VoiceService } from '../../core/services/party/voice.service';
import { PartyService } from '../../core/services/party/party.service';
import { PlayerStateService } from '../../core/services/player-state.service';
import { MediaService } from '../../core/services/api/media.service';
import { PlayerSettingsService } from '../../core/services/player-settings.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { RemotePlaybackTarget } from '../../core/services/remote-playback-target';
import { ToastService } from '../../core/services/toast.service';
import { LocalPlaybackOutput, type LocalOutputHost } from './local-playback-output';
import { PartyController, type PartyHost } from './party-controller';
import { QueueController } from './queue-controller';

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
    upNext: () => null,
    queueItems: () =>
      opts.film
        ? []
        : [
            { mediaId: 1, mediaFileId: 10, episodeId: 100, title: '' },
            { mediaId: 1, mediaFileId: 11, episodeId: 101, title: '' },
          ],
    queueIndex: () => 0,
    openPartyItem: vi.fn().mockResolvedValue(opts.opens ?? true),
  };
  const toast = { info: vi.fn(), error: vi.fn() };
  const route = { snapshot: { queryParams: opts.urlParty ? { party: opts.urlParty } : {} } };
  const router = { navigate: vi.fn(), navigateByUrl: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      PartyController,
      PlayerStateService,
      { provide: PartyService, useValue: party },
      { provide: ClockService, useValue: { serverNow: () => Date.now(), rttMs: signal(0) } },
      { provide: QueueController, useValue: queue },
      { provide: VoiceService, useValue: { duck: signal(false), othersSpeaking: signal(false), joined: signal(false) } },
      { provide: CastService, useValue: cast },
      { provide: CastPlayerService, useValue: { hasMedia: signal(true), mediaId: signal(1), episodeId: signal(undefined), availableQualities: signal([]) } },
      CastPlaybackTarget,
      { provide: RemotePlaybackTarget, useValue: { isConnected: signal(false) } },
      { provide: MediaService, useValue: {} },
      { provide: PlayerSettingsService, useValue: { settings: () => ({ autoPlayNext: false }) } },
      { provide: DeviceService, useValue: { tvPlatform: () => null, isTv: () => false } },
      { provide: ToastService, useValue: toast },
      { provide: ActivatedRoute, useValue: route },
      { provide: Router, useValue: router },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ],
  });
  const ctl = TestBed.inject(PartyController);
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
    position: () => 0,
    onBack: vi.fn(),
  } as unknown as PartyHost & LocalOutputHost;
  TestBed.inject(PlaybackSession).attachLocal(new LocalPlaybackOutput(host, state));
  ctl.attach(host);
  return { closed, ctl, party, state, engine, host, queue, toast, cast, router, route };
}

describe('PartyController user actions', () => {
  it('shows the controls when the party goes from playing to paused, whoever paused', () => {
    const { ctl, party, host } = setup();
    party.live.set({ state: 'playing' });
    TestBed.tick();
    expect(host.showControls).not.toHaveBeenCalled();
    party.live.set({ state: 'paused' });
    TestBed.tick();
    expect(host.showControls).toHaveBeenCalledTimes(1);
    ctl.dispose();
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
    ctl.dispose();
  });

  it('turns a seek into an intent and releases the drag lock', () => {
    const { ctl, party, state, host } = setup();
    state.seekLocked.set(true);
    expect(ctl.seek(120)).toBe(true);
    expect(party.sendIntent).toHaveBeenCalledWith('seek', { position: 120 });
    expect(state.seekLocked()).toBe(false);
    expect(host.seekTo).not.toHaveBeenCalled();
    ctl.dispose();
  });

  it('does nothing and says why when the policy is host-only', () => {
    const { ctl, party, toast } = setup({ canControl: false });
    party.live.set({ state: 'paused' });
    ctl.togglePlay();
    expect(party.sendIntent).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalled();
    ctl.dispose();
  });

  it('sends a picked queue item as one setItem intent and does not navigate', async () => {
    const { ctl, party, router } = setup();
    await ctl.requestQueueItem(1);
    expect(party.sendIntent).toHaveBeenCalledWith('setItem', {
      item: { mediaId: 1, mediaFileId: 11, episodeId: 101 },
    });
    expect(router.navigate).not.toHaveBeenCalled();
    ctl.dispose();
  });

  it('ignores the playing item and refuses a pick without control', async () => {
    const { ctl, party, toast } = setup();
    await ctl.requestQueueItem(0);
    expect(party.sendIntent).not.toHaveBeenCalled();
    party.canControl.set(false);
    await ctl.requestQueueItem(1);
    expect(party.sendIntent).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalled();
    ctl.dispose();
  });

  it('lets the player act normally outside a party', () => {
    const { ctl, party } = setup();
    party.active.set(false);
    expect(ctl.togglePlay()).toBe(false);
    expect(ctl.seek(5)).toBe(false);
    ctl.dispose();
  });
});

describe('PartyController queue', () => {
  it('asks the server for the next and the previous item instead of picking one', async () => {
    const { ctl, party, router } = setup({ joined: 3 });
    await ctl.requestNext();
    await ctl.requestPrevious();
    expect(party.sendIntent.mock.calls).toEqual([['next'], ['previous']]);
    expect(router.navigate).not.toHaveBeenCalled();
    ctl.dispose();
  });

  it('refuses next and previous without control', async () => {
    const { ctl, party, toast } = setup({ joined: 3, canControl: false });
    await ctl.requestNext();
    await ctl.requestPrevious();
    expect(party.sendIntent).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(2);
    ctl.dispose();
  });

  it('reports the end of an item and lets the server advance', async () => {
    const { ctl, party, state } = setup({ joined: 3 });
    party.isHost.set(true);
    state.ended.set(true);
    TestBed.tick();
    await Promise.resolve();
    expect(party.sendIntent.mock.calls).toEqual([['ended', { item: { mediaId: 1 } }]]);
    ctl.dispose();
  });

  it('leaves the answer on a film to the server', async () => {
    const { ctl, party } = setup({ joined: 3, film: true });
    await ctl.requestNext();
    await ctl.requestPrevious();
    expect(party.sendIntent.mock.calls).toEqual([['next'], ['previous']]);
    ctl.dispose();
  });

  it('leaves the party instead of syncing the old item when the new one cannot be opened', async () => {
    const { ctl, party, state, host } = setup({ joined: 3, opens: false });
    state.videoStarted.set(true);
    party.live.set({ state: 'paused', item: { mediaId: 2, episodeId: null }, anchor: { position: 5, serverTimeMs: 0 } });
    TestBed.tick();
    await new Promise<void>((r) => setTimeout(r));
    expect(host.onBack).toHaveBeenCalled();
    expect(host.seekTo).not.toHaveBeenCalled();
    expect(party.reportStatus).not.toHaveBeenCalledWith('ready', expect.anything());
    ctl.dispose();
  });

  it('sends an item picked from the queue menu as setItem', async () => {
    const { ctl, party } = setup({ joined: 3 });
    await ctl.requestQueueItem(1);
    expect(party.sendIntent).toHaveBeenCalledWith('setItem', {
      item: { mediaId: 1, mediaFileId: 11, episodeId: 101 },
    });
    ctl.dispose();
  });
});

describe('PartyController resume from the URL', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r));

  it('joins the party named by a reloaded player URL', () => {
    const { ctl, party } = setup({ urlParty: '37' });
    expect(party.resume).toHaveBeenCalledWith(37);
    ctl.dispose();
  });

  it('does not join twice when the app already is in that party', () => {
    const { ctl, party } = setup({ urlParty: '37', joined: 37 });
    expect(party.resume).not.toHaveBeenCalled();
    ctl.dispose();
  });

  it('does nothing without the param', () => {
    const { ctl, party } = setup();
    expect(party.resume).not.toHaveBeenCalled();
    ctl.dispose();
  });

  it('toasts and drops the param when the party cannot be rejoined', async () => {
    const { ctl, toast, router } = setup({ urlParty: '37', resumes: false });
    await flush();
    expect(toast.error).toHaveBeenCalledWith('party.error_resume');
    expect(router.navigate).toHaveBeenCalledWith([], expect.objectContaining({ queryParams: { party: null }, replaceUrl: true }));
    ctl.dispose();
  });

  it('keeps the param after a successful join', async () => {
    const { ctl, toast, router } = setup({ urlParty: '37' });
    await flush();
    expect(toast.error).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
    ctl.dispose();
  });
});

describe('PartyController on a Cast session', () => {
  it('turns the overlay controls into intents and leaves the receiver alone', () => {
    const { ctl, party, cast } = setup();
    cast.isConnected.set(true);
    cast.isPaused.set(false);
    party.live.set({ state: 'playing' });
    expect(ctl.togglePlay()).toBe(true);
    expect(party.sendIntent).toHaveBeenCalledWith('pause');
    expect(cast.pause).not.toHaveBeenCalled();
    ctl.dispose();
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
    ctl.dispose();
    vi.useRealTimers();
  });
});

describe('PartyController leaving', () => {
  it('lands on the Home when the host ends the party', () => {
    const { ctl, closed, router, host } = setup();
    closed.next();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/', { replaceUrl: true });
    expect(host.onBack).not.toHaveBeenCalled();
    ctl.dispose();
  });

  it('lands on the Home when a member leaves, and stays put when the host declines', async () => {
    const { ctl, party, router } = setup();
    await ctl.leave();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/', { replaceUrl: true });
    router.navigateByUrl.mockClear();
    party.leaveOrEnd.mockResolvedValue(false);
    await ctl.leave();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    ctl.dispose();
  });
});
