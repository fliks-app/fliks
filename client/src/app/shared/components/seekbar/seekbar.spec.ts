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



  it('leaves Up and Down to the page so they can open the full controls', () => {
    const seeks: number[] = [];
    bar.seek.subscribe((t) => seeks.push(t));

    // The bar used to step chapters here and swallow the key; opening the
    // controls is the more useful answer and needs the event to bubble.
    const up = press('ArrowUp');
    bar.onKeydown(up);
    bar.onKeydown(press('ArrowDown'));

    expect(seeks).toEqual([]);
    // Not swallowed: the player's own handler is what opens the controls.
    expect(up.preventDefault).not.toHaveBeenCalled();
    expect(up.stopPropagation).not.toHaveBeenCalled();
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

describe('SeekbarComponent EDL bands', () => {
  function build(ranges: { start: number; end: number; action: 'cut' | 'mute' | 'commercial' }[]) {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: TvService, useValue: { isTv: () => false } }],
    });
    const fixture = TestBed.createComponent(SeekbarComponent);
    fixture.componentRef.setInput('duration', 1000);
    fixture.componentRef.setInput('edlRanges', ranges);
    return fixture.componentInstance;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('draws cuts and commercials as bands and leaves mutes out of them', () => {
    const bar = build([
      { start: 100, end: 150, action: 'cut' },
      { start: 500, end: 600, action: 'commercial' },
      { start: 700, end: 701, action: 'mute' },
    ]);
    expect(bar.edlBands()).toEqual([
      { kind: 'cut', left: 10, width: 5 },
      { kind: 'commercial', left: 50, width: 10 },
    ]);
  });

  it('folds hundreds of mute ranges into one gradient', () => {
    const mutes = Array.from({ length: 400 }, (_, i) => ({
      start: i * 2,
      end: i * 2 + 0.5,
      action: 'mute' as const,
    }));
    const bar = build(mutes);
    const strip = bar.muteStrip()!;
    expect(strip.startsWith('linear-gradient(to right,')).toBe(true);
    expect(strip.split('var(--color-accent)').length - 1).toBe(400);
    expect(bar.edlBands()).toEqual([]);
  });

  it('clamps bands to the track', () => {
    const bar = build([
      { start: -5, end: 20, action: 'cut' },
      { start: 990, end: 1500, action: 'commercial' },
      { start: 1200, end: 1300, action: 'cut' },
    ]);
    expect(bar.edlBands()).toEqual([
      { kind: 'cut', left: 0, width: 2 },
      { kind: 'commercial', left: 99, width: 1 },
    ]);
  });

  it('has no strip without mutes', () => {
    expect(build([{ start: 1, end: 2, action: 'cut' }]).muteStrip()).toBeNull();
  });
});
