import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { describe, expect, it, vi } from 'vitest';
import { DeviceService } from '../../core/services/device.service';
import { ClockService } from '../../core/services/party/clock.service';
import { PartyService } from '../../core/services/party/party.service';
import { PlayerStateService } from '../../core/services/player-state.service';
import { ToastService } from '../../core/services/toast.service';
import { PartyController, type PartyHost } from './party-controller';
import { QueueController } from './queue-controller';

function setup(opts: { canControl?: boolean } = {}) {
  const party = {
    active: signal(true),
    live: signal<unknown>(null),
    canControl: signal(opts.canControl ?? true),
    isHost: signal(false),
    closed: { subscribe: () => ({ unsubscribe: () => {} }) },
    sendIntent: vi.fn().mockResolvedValue(undefined),
    reportStatus: vi.fn(),
    leave: vi.fn(),
  };
  const queue = { upNext: () => null, interceptAdvance: null as unknown };
  const toast = { info: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      PartyController,
      PlayerStateService,
      { provide: PartyService, useValue: party },
      { provide: ClockService, useValue: { serverNow: () => Date.now(), rttMs: signal(0) } },
      { provide: QueueController, useValue: queue },
      { provide: DeviceService, useValue: { tvPlatform: () => null } },
      { provide: ToastService, useValue: toast },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ],
  });
  const ctl = TestBed.inject(PartyController);
  const state = TestBed.inject(PlayerStateService);
  const engine = { play: vi.fn(), pause: vi.fn(), seek: vi.fn(), paused: false, playbackRate: 1, currentTime: 0 };
  const host: PartyHost = {
    engine: () => engine as never,
    mediaId: () => 1,
    episodeId: () => undefined,
    seekTo: vi.fn(),
    pausePlayback: vi.fn().mockResolvedValue(undefined),
    playLocal: vi.fn(),
    position: () => 0,
    onBack: vi.fn(),
  };
  ctl.attach(host);
  return { ctl, party, state, engine, host, queue, toast };
}

describe('PartyController user actions', () => {
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

  it('lets the player act normally outside a party', () => {
    const { ctl, party } = setup();
    party.active.set(false);
    expect(ctl.togglePlay()).toBe(false);
    expect(ctl.seek(5)).toBe(false);
    ctl.dispose();
  });
});
