import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { SeekbarComponent } from './seekbar';

/** Keyboard scrubbing has no cursor to hold the preview open, so the tooltip
 *  lingers on a timer instead. These drive the component directly. */
describe('SeekbarComponent keyboard preview', () => {
  let bar: SeekbarComponent;

  const arrow = (key: 'ArrowLeft' | 'ArrowRight') =>
    ({ key, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as KeyboardEvent;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(SeekbarComponent);
    bar = fixture.componentInstance;
    fixture.componentRef.setInput('duration', 600);
    fixture.componentRef.setInput('currentTime', 100);
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('outlives the key release, then retires on its own', () => {
    bar.onKeydown(arrow('ArrowRight'));
    bar.onKeyup(arrow('ArrowRight'));

    // The drag is committed, but the preview is still up on the target.
    expect(bar.dragging()).toBe(false);
    expect(bar.previewVisible()).toBe(true);
    expect(bar.previewTime()).toBe(110);

    vi.advanceTimersByTime(2300);
    expect(bar.previewVisible()).toBe(false);
  });

  it('a run of presses coalesces into one seek and keeps one preview alive', () => {
    const seeks: number[] = [];
    bar.seek.subscribe((t) => seeks.push(t));

    // Inside the 250ms commit backstop, so the run accumulates.
    for (let i = 0; i < 3; i++) {
      bar.onKeydown(arrow('ArrowRight'));
      vi.advanceTimersByTime(100);
      expect(bar.previewVisible()).toBe(true);
    }
    bar.onKeyup(arrow('ArrowRight'));

    expect(seeks).toEqual([130]);
    // Still up well past the last press, then retires.
    vi.advanceTimersByTime(1500);
    expect(bar.previewVisible()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(bar.previewVisible()).toBe(false);
  });
});
