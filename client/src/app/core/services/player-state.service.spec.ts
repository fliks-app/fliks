import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import { PlayerStateService } from './player-state.service';
import type { PlaybackEngine, PlaybackState } from './playback-engine/playback-engine';

/** Records the handlers `bindEngine` registers so a test can fire them. */
function fakeEngine() {
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  const engine = {
    volume: 1,
    muted: false,
    currentTime: 0,
    on: (event: string, handler: (data: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
  } as unknown as PlaybackEngine;
  const fire = (event: string, data: unknown) =>
    handlers.get(event)?.forEach((h) => h(data));
  return { engine, fire };
}

function setup() {
  TestBed.configureTestingModule({
    providers: [
      PlayerStateService,
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ],
  });
  const service = TestBed.inject(PlayerStateService);
  const { engine, fire } = fakeEngine();
  service.bindEngine(engine);
  const state = (s: PlaybackState) => fire('stateChanged', { state: s });
  return { service, state, fire };
}

/**
 * The spinner hides the play button, so a buffering flag that cannot clear
 * strands the viewer: the only clear path needs a playhead that advances, and
 * a paused one never does.
 */
describe('PlayerStateService buffering latch', () => {
  it('shows the spinner for a stall during playback', () => {
    const { service, state } = setup();
    state('playing');
    state('buffering');
    expect(service.buffering()).toBe(true);
  });

  it('does not latch a stall reported after a pause', () => {
    const { service, state } = setup();
    state('playing');
    state('paused');
    // Engines keep filling their buffer while paused and report it.
    state('buffering');
    expect(service.paused()).toBe(true);
    expect(service.buffering()).toBe(false);
  });

  it('clears a latched spinner once the playhead advances', () => {
    const { service, state, fire } = setup();
    state('playing');
    state('buffering');
    fire('timeUpdate', { position: 12, duration: 100, buffered: 20 });
    expect(service.buffering()).toBe(false);
  });
});
