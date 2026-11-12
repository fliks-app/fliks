import { Component, provideZonelessChangeDetection, signal, viewChild, type TemplateRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioOutput } from '../../core/services/audio-player/audio-output';
import { SwipeTrackComponent } from './swipe-track';

@Component({ template: '<ng-template #lines let-n>{{ n?.title }}</ng-template>' })
class Lines {
  readonly lines = viewChild.required<TemplateRef<unknown>>('lines');
}

type Drive = { onDragged(dx: number): void; onReleased(d: 'next' | 'previous' | null): void };

function setup() {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const host = TestBed.createComponent(Lines);
  host.detectChanges();
  const fixture = TestBed.createComponent(SwipeTrackComponent);
  fixture.componentRef.setInput('lines', host.componentInstance.lines());
  const neighbour = (step: 1 | -1) => ({ itemId: step, title: `T${step}`, artists: 'A', coverUrl: `/c${step}.jpg` });
  fixture.componentRef.setInput('output', { queue: signal([{}, {}, {}]), neighbour } as unknown as AudioOutput);
  const skipped = vi.fn();
  fixture.componentInstance.skipped.subscribe(skipped);
  return { c: fixture.componentInstance, drive: fixture.componentInstance as unknown as Drive, skipped };
}

describe('SwipeTrackComponent', () => {
  afterEach(() => vi.useRealTimers());

  it('slides on to the neighbour before skipping, its cover held over the bar until the bar has its own', () => {
    vi.useFakeTimers();
    const { c, drive, skipped } = setup();
    drive.onDragged(-0.6);
    expect(c.cover()).toMatchObject({ url: '/c1.jpg', settle: false });
    drive.onReleased('next');
    expect(skipped).not.toHaveBeenCalled();
    expect(c.cover()).toMatchObject({ opacity: 1, settle: true });
    vi.advanceTimersByTime(220);
    expect(skipped).toHaveBeenCalledWith('next');
    expect(c.cover()?.opacity).toBe(1);
    vi.advanceTimersByTime(300);
    expect(c.cover()).toBeNull();
  });

  it('slides back without skipping when released short', () => {
    vi.useFakeTimers();
    const { c, drive, skipped } = setup();
    drive.onDragged(0.2);
    drive.onReleased(null);
    expect(c.cover()).toMatchObject({ url: '/c-1.jpg', opacity: 0, settle: true });
    vi.advanceTimersByTime(220);
    expect(skipped).not.toHaveBeenCalled();
    expect(c.cover()).toBeNull();
  });
});
