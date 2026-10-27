import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CastPlaybackTarget } from '../cast-playback-target';
import { PartyService } from '../party/party.service';
import { RemotePlaybackTarget } from '../remote-playback-target';
import type { PlaybackOutput } from './playback-output';
import { PlaybackSession } from './playback-session';

function target() {
  return {
    isConnected: signal(false),
    togglePlayPause: vi.fn(),
    seek: vi.fn(),
    playNext: vi.fn(),
  };
}

function setup() {
  const cast = target();
  const remote = target();
  const party = { active: signal(false) };
  TestBed.configureTestingModule({
    providers: [
      { provide: CastPlaybackTarget, useValue: cast },
      { provide: RemotePlaybackTarget, useValue: remote },
      { provide: PartyService, useValue: party },
    ],
  });
  const session = TestBed.inject(PlaybackSession);
  const local = { id: 'local' } as unknown as PlaybackOutput;
  return { session, cast, remote, party, local };
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
    const other = { id: 'other' } as unknown as PlaybackOutput;
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
});
