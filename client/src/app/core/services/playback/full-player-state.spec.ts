import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { FullPlayerState } from './full-player-state';

describe('FullPlayerState', () => {
  it('hands only the open family over', () => {
    const full = TestBed.inject(FullPlayerState);
    full.show('video', true);
    full.handTo('audio', false);
    expect(full.remote()).toBe(true);
    full.handTo('video', false);
    expect(full.remote()).toBe(false);
  });

  it('follows a video hand-over without touching an audio player', () => {
    const full = TestBed.inject(FullPlayerState);
    full.show('audio', false);
    full.handTo('video', true);
    expect(full.remote()).toBe(false);
    full.show('video', false);
    full.handTo('video', true);
    expect(full.remote()).toBe(true);
  });
});
