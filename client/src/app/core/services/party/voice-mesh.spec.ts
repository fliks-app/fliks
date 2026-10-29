import { describe, expect, it } from 'vitest';
import type { PartyMember } from '../api/party-api.service';
import { diffPeers, offersTo, peerKey, rms, routeSignal } from './voice-mesh';

const member = (deviceId: string, voice: boolean, status: PartyMember['status'] = 'ready', userId = 1): PartyMember => ({
  userId, username: 'u', deviceId, role: 'member', status, deviceName: null, formFactor: null,
  voice: voice ? { muted: true } : null,
});

const me = { userId: 1, deviceId: 'me' };

describe('offer direction', () => {
  it('the lower key offers, never both', () => {
    expect(offersTo({ userId: 1, deviceId: 'a' }, { userId: 1, deviceId: 'b' })).toBe(true);
    expect(offersTo({ userId: 1, deviceId: 'b' }, { userId: 1, deviceId: 'a' })).toBe(false);
  });
});

describe('diffPeers', () => {
  it('opens peers for voice members and ignores self and non-voice', () => {
    const d = diffPeers([], [member('me', true), member('a', true), member('b', false)], me);
    expect(d).toEqual({ add: [{ userId: 1, deviceId: 'a' }], remove: [] });
  });

  it('tells apart two users reusing a deviceId', () => {
    const d = diffPeers([], [member('x', true, 'ready', 1), member('x', true, 'ready', 2)], me);
    expect(d.add).toEqual([{ userId: 1, deviceId: 'x' }, { userId: 2, deviceId: 'x' }]);
    expect(diffPeers([peerKey({ userId: 1, deviceId: 'x' })], [member('x', true, 'ready', 2)], me).remove).toEqual(['1:x']);
  });

  it('closes a peer whose member lost voice or left, and drops an away member', () => {
    const d = diffPeers(['1:a', '1:b', '1:c'], [member('a', false), member('b', true, 'away'), member('c', true)], me);
    expect(d).toEqual({ add: [], remove: ['1:a', '1:b'] });
  });

  it('reopens an away member once it returns', () => {
    expect(diffPeers([], [member('a', true)], me).add).toEqual([{ userId: 1, deviceId: 'a' }]);
  });
});

describe('routeSignal', () => {
  it('an offer always replaces the peer', () => {
    expect(routeSignal('offer', true, false)).toBe('accept-offer');
    expect(routeSignal('offer', false, false)).toBe('accept-offer');
  });

  it('other kinds need a live peer', () => {
    expect(routeSignal('answer', false, false)).toBe('ignore');
    expect(routeSignal('answer', true, false)).toBe('apply-answer');
    expect(routeSignal('ice', true, false)).toBe('add-ice');
  });

  it('bye closes, bye with retry renegotiates', () => {
    expect(routeSignal('bye', true, false)).toBe('close');
    expect(routeSignal('bye', true, true)).toBe('retry');
  });
});

describe('rms', () => {
  it('is 0 for silence and grows with amplitude', () => {
    expect(rms(new Uint8Array(8).fill(128))).toBe(0);
    expect(rms(new Uint8Array([192, 64, 192, 64]))).toBeCloseTo(0.5);
  });
});
