import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { SeekbarComponent } from './seekbar';
import { TvService } from '../../../core/services/tv.service';

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

    // A release no longer ends the run — the user may still be tapping.
    expect(bar.dragging()).toBe(true);
    expect(bar.previewTime()).toBe(110);

    vi.advanceTimersByTime(800);
    expect(bar.dragging()).toBe(false);
    // Committed, but the preview is still up on the target.
    expect(bar.previewVisible()).toBe(true);
    expect(bar.previewTime()).toBe(110);

    vi.advanceTimersByTime(1600);
    expect(bar.previewVisible()).toBe(false);
  });

  it('accumulates discrete taps into one growing offset', () => {
    const seeks: number[] = [];
    bar.seek.subscribe((t) => seeks.push(t));

    // Press and release three times, pausing inside the idle window each time.
    for (const expected of [110, 120, 130]) {
      bar.onKeydown(arrow('ArrowRight'));
      bar.onKeyup(arrow('ArrowRight'));
      vi.advanceTimersByTime(300);
      expect(bar.previewTime()).toBe(expected);
      expect(seeks).toEqual([]);
    }

    vi.advanceTimersByTime(800);
    expect(seeks).toEqual([130]);
  });

  it('keeps the small step across taps at a human cadence, not the wall-clock age of the run', () => {
    const seeks: number[] = [];
    bar.seek.subscribe((t) => seeks.push(t));

    // Each gap sits just inside the idle window, so the run never breaks -
    // but the cumulative age of the run alone would cross the 1.5s/4s/8s
    // acceleration thresholds well before the last of these five taps.
    for (const expected of [110, 120, 130, 140, 150]) {
      bar.onKeydown(arrow('ArrowRight'));
      bar.onKeyup(arrow('ArrowRight'));
      vi.advanceTimersByTime(600);
      expect(bar.previewTime()).toBe(expected);
    }

    vi.advanceTimersByTime(800);
    expect(seeks).toEqual([150]);
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

    vi.advanceTimersByTime(800);
    expect(seeks).toEqual([130]);
    // Still up past the commit, then retires.
    expect(bar.previewVisible()).toBe(true);
    vi.advanceTimersByTime(1600);
    expect(bar.previewVisible()).toBe(false);
  });
});

/** A pointer drag started while a key-scrub commit is still pending must take
 *  over that commit, not have it fire mid-drag on the wrong position. */
describe('SeekbarComponent pointer drag vs pending key scrub', () => {
  let bar: SeekbarComponent;

  const arrow = (key: 'ArrowLeft' | 'ArrowRight') =>
    ({ key, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as KeyboardEvent;

  const rectOf = (width: number) =>
    ({ left: 0, right: width, width, top: 0, bottom: 10, height: 10, x: 0, y: 0, toJSON() {} }) as DOMRect;

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

  it('a drag grabbed inside the scrub window owns the commit and lands on release, not the stale timer', () => {
    const seeks: number[] = [];
    bar.seek.subscribe((t) => seeks.push(t));

    // Arm a pending commit due at t=700.
    bar.onKeydown(arrow('ArrowRight'));

    const barEl = document.createElement('div');
    barEl.getBoundingClientRect = () => rectOf(1000);

    // Grab the bar within the 700ms window, at an interim position.
    vi.advanceTimersByTime(200);
    bar.onProgressDown({
      currentTarget: barEl,
      pointerId: 1,
      clientX: 300,
      preventDefault: vi.fn(),
    } as unknown as PointerEvent);

    // Past the original 700ms deadline: if the stale timer had survived it
    // would have committed here, at the interim position, ending the drag.
    vi.advanceTimersByTime(700);
    expect(seeks).toEqual([]);
    expect(bar.dragging()).toBe(true);

    // Move on to the real release position and let go.
    const move = new Event('pointermove') as unknown as PointerEvent;
    (move as { clientX: number }).clientX = 800;
    document.dispatchEvent(move);
    document.dispatchEvent(new Event('pointerup'));

    expect(bar.dragging()).toBe(false);
    expect(seeks).toEqual([480]); // 800/1000 of the 600s duration
  });
});

/** Chapter-aware scrubbing: the readouts under the bar and the vertical
 *  binding that only exists while the seek OSD is up. */
describe('SeekbarComponent chapters', () => {
  let bar: SeekbarComponent;
  let fixture: ReturnType<typeof TestBed.createComponent<SeekbarComponent>>;

  const CHAPTERS = [
    { startSeconds: 0, endSeconds: 120, title: 'Cold open' },
    { startSeconds: 120, endSeconds: 300, title: 'Act one' },
    { startSeconds: 300, endSeconds: 600, title: 'Act two' },
  ];

  const press = (key: string) =>
    ({ key, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as KeyboardEvent;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    fixture = TestBed.createComponent(SeekbarComponent);
    bar = fixture.componentInstance;
    fixture.componentRef.setInput('duration', 600);
    fixture.componentRef.setInput('currentTime', 100);
    fixture.componentRef.setInput('chapters', CHAPTERS);
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('names the chapter the preview sits in and shows the signed offset', () => {
    bar.onKeydown(press('ArrowRight'));
    bar.onKeydown(press('ArrowRight'));

    // 100 → 120, which is the first frame of the next chapter.
    expect(bar.previewTime()).toBe(120);
    expect(bar.previewChapter()).toBe('Act one');
    expect(bar.formatDelta(bar.previewDelta())).toBe('+0:20');

    bar.onKeydown(press('ArrowLeft'));
    expect(bar.previewChapter()).toBe('Cold open');
    expect(bar.formatDelta(bar.previewDelta())).toBe('+0:10');
  });

  it('reports no offset when nothing is being scrubbed', () => {
    expect(bar.previewDelta()).toBe(0);
  });

  it('snaps a commit that lands near a chapter edge onto it', () => {
    const seeks: number[] = [];
    bar.seek.subscribe((t) => seeks.push(t));

    // 100 + 3x10 = 130 is 10s past the edge at 120 — outside the window.
    for (let i = 0; i < 3; i++) bar.onKeydown(press('ArrowRight'));
    bar.onKeyup(press('ArrowRight'));
    vi.advanceTimersByTime(800);
    expect(seeks).toEqual([130]);
  });

  it('snaps when the accumulated target is inside the window', () => {
    const seeks: number[] = [];
    fixture.componentRef.setInput('currentTime', 113);
    bar.seek.subscribe((t) => seeks.push(t));

    bar.onKeydown(press('ArrowRight'));
    bar.onKeyup(press('ArrowRight'));
    vi.advanceTimersByTime(800);
    // 123 is 3s from the edge at 120 → snapped.
    expect(seeks).toEqual([120]);
  });

  it('binds Up/Down to chapter steps only while the OSD asked for it', () => {
    const seeks: number[] = [];
    bar.seek.subscribe((t) => seeks.push(t));

    // Not raised: vertical stays free so focus can escape the slider.
    expect(bar.ownsVertical()).toBe(false);
    bar.onKeydown(press('ArrowDown'));
    expect(seeks).toEqual([]);

    fixture.componentRef.setInput('chapterSkip', true);
    expect(bar.ownsVertical()).toBe(true);

    // Stepped from the playhead at 100, not from the head of the file.
    bar.onKeydown(press('ArrowDown'));
    expect(seeks).toEqual([120]);
    bar.onKeydown(press('ArrowUp'));
    expect(seeks).toEqual([120, 0]);
  });

  it('keeps vertical free on a file with no chapters', () => {
    fixture.componentRef.setInput('chapterSkip', true);
    fixture.componentRef.setInput('chapters', []);
    expect(bar.ownsVertical()).toBe(false);
  });

  it('measures the intro and outro bands against the duration', () => {
    fixture.componentRef.setInput('introMarker', { startSeconds: 30, endSeconds: 90 });
    fixture.componentRef.setInput('outroMarker', { startSeconds: 570, endSeconds: 600 });

    expect(bar.markerBands()).toEqual([
      { kind: 'intro', left: 5, width: 10 },
      { kind: 'outro', left: 95, width: 5 },
    ]);
  });

  it('drops a marker with no span', () => {
    fixture.componentRef.setInput('introMarker', { startSeconds: 60, endSeconds: 60 });
    expect(bar.markerBands()).toEqual([]);
  });
});

/** The sprite frame is sized by width on a browser, but a wide film is short at
 *  a fixed width — on TV the height is bounded too. */
describe('SeekbarComponent preview size', () => {
  const SPRITE = { interval: 10, columns: 10, count: 100 };

  function build(isTv: boolean, thumbWidth: number, thumbHeight: number) {
    // Each case needs its own TvService, so start from a clean TestBed.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: TvService, useValue: { isTv: () => isTv } },
      ],
    });
    const fixture = TestBed.createComponent(SeekbarComponent);
    fixture.componentRef.setInput('duration', 600);
    fixture.componentRef.setInput('spriteMetadata', { ...SPRITE, thumbWidth, thumbHeight });
    // previewWidth/Height are protected — read them off the instance.
    const bar = fixture.componentInstance as unknown as {
      previewWidth: () => number;
      previewHeight: () => number;
    };
    return { w: Math.round(bar.previewWidth()), h: Math.round(bar.previewHeight()) };
  }

  afterEach(() => TestBed.resetTestingModule());

  it('gives every aspect the same height on TV', () => {
    // Sprites are a fixed 240 wide; the height follows the source aspect.
    const wide = build(true, 240, 100); // 2.40:1
    const std = build(true, 240, 135); // 16:9
    const old = build(true, 240, 180); // 4:3

    expect(wide.h).toBe(170);
    expect(std.h).toBe(170);
    expect(old.h).toBe(170);
    // The width is what varies, and the widest still clears the ceiling.
    expect(wide.w).toBe(408);
    expect(std.w).toBe(302);
    expect(old.w).toBe(227);
  });

  it('leaves the browser sizing alone', () => {
    const wide = build(false, 240, 100);
    // Width-capped at 224 as before, so a wide film stays short here.
    expect(wide.w).toBe(224);
    expect(wide.h).toBe(93);
  });
});
