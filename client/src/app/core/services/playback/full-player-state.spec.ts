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
});
