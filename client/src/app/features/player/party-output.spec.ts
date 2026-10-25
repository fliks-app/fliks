import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { CastPartyOutput } from './party-output';

function make() {
  const cast = {
    isConnected: signal(true),
    isPaused: signal(true),
    buffering: signal(false),
    ended: signal(false),
    currentTime: signal(12),
    duration: signal(0),
    seek: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
  };
  const player = { hasMedia: signal(true), mediaId: signal(7), episodeId: signal<number | undefined>(3) };
  return { cast, player, out: new CastPartyOutput(cast, player) };
}

describe('CastPartyOutput', () => {
  it('is ready only once the receiver reports a duration', () => {
    const { cast, player, out } = make();
    expect(out.ready()).toBe(false);
    cast.duration.set(3600);
    expect(out.ready()).toBe(true);
    player.hasMedia.set(false);
    expect(out.ready()).toBe(false);
  });

  it('reads the receiver state and the cast item', () => {
    const { cast, out } = make();
    cast.isPaused.set(false);
    cast.buffering.set(true);
    expect(out.paused()).toBe(false);
    expect(out.buffering()).toBe(true);
    expect(out.position()).toBe(12);
    expect(out.item()).toEqual({ mediaId: 7, episodeId: 3 });
    cast.ended.set(true);
    expect(out.ended()).toBe(true);
  });

  it('drives the receiver', async () => {
    const { cast, out } = make();
    out.seekTo(40);
    out.play();
    await out.pause();
    expect(cast.seek).toHaveBeenCalledWith(40);
    expect(cast.play).toHaveBeenCalled();
    expect(cast.pause).toHaveBeenCalled();
    expect(out.rate).toBeUndefined();
  });
});
