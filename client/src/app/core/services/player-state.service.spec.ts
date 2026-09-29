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

/**
 * fatalNoRetry survives setRecovering(true) (which only clears `error`), so a
 * stale flag from a previous undecodable failure must not keep blocking
 * checkStall's retries after a later recovery actually succeeds.
 */
describe('PlayerStateService fatalNoRetry', () => {
  it('clears once recovery resolves without reintroducing an error', () => {
    const { service } = setup();
    service.setError('boom', { source: 'shaka', code: 3016 });
    expect(service.fatalNoRetry()).toBe(true);
    service.setRecovering(true);
    service.setRecovering(false);
    expect(service.fatalNoRetry()).toBe(false);
  });

  it('stays set when recovery re-fails with a new fatal error', () => {
    const { service } = setup();
    service.setError('boom', { source: 'shaka', code: 3016 });
    service.setRecovering(true);
    service.setError('boom again', { source: 'shaka', code: 3016 });
    service.setRecovering(false);
    expect(service.fatalNoRetry()).toBe(true);
  });
});

describe('PlayerStateService.failWith', () => {
  it('classifies a Shaka-shaped error and sets source/code/message', () => {
    const { service } = setup();
    const msg = service.failWith({ category: 4, code: 4032, message: 'nope' });
    expect(service.error()?.source).toBe('shaka');
    expect(service.error()?.code).toBe(4032);
    expect(service.error()?.message).toBe('nope');
    expect(msg).toBe('player.error_unsupported');
  });

  it('honors an explicit source override for a synthetic (non-exception) failure', () => {
    const { service } = setup();
    service.failWith(undefined, { source: 'session' });
    expect(service.error()?.source).toBe('session');
  });
});

describe('PlayerStateService startup transport', () => {
  it('never exposes paused between ready and playing', () => {
    const { service, state } = setup();
    service.reset();
    state('paused');
    state('buffering');
    expect(service.paused()).toBe(true);
    expect(service.uiPaused()).toBe(false);
    state('playing');
    expect(service.uiPaused()).toBe(false);
  });

  it('shows play for a refused autoplay', () => {
    const { service, state } = setup();
    service.reset();
    state('paused');
    service.autoplayBlocked.set(true);
    expect(service.uiPaused()).toBe(true);
  });

  it('shows play for a pause after playback started', () => {
    const { service, state } = setup();
    service.reset();
    state('playing');
    state('paused');
    expect(service.uiPaused()).toBe(true);
  });

  it('stops counting the launch as in flight on an engine error event', () => {
    const { service, state, fire } = setup();
    service.reset();
    state('paused');
    fire('error', { source: 'engine', code: 1 });
    expect(service.startingPlayback()).toBe(false);
  });

  it('arms again for the next session', () => {
    const { service, state } = setup();
    state('playing');
    service.reset();
    state('paused');
    expect(service.uiPaused()).toBe(false);
  });
});
