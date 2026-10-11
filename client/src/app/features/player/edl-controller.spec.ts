import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import type { EdlRange, TimeRange } from '../../core/utils/edl-policy';
import { EdlController } from './edl-controller';

class FakeEngine {
  paused = false;
  playbackRate = 1;
  currentTime = 0;
  mutes: TimeRange[][] = [];
  private handlers = new Map<string, Set<(e: any) => void>>();
  on(ev: string, h: (e: any) => void) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(h);
  }
  off(ev: string, h: (e: any) => void) {
    this.handlers.get(ev)?.delete(h);
  }
  emit(ev: string, e: unknown) {
    this.handlers.get(ev)?.forEach((h) => h(e));
  }
  setMuteRanges(r: TimeRange[]) {
    this.mutes.push(r);
  }
  time(position: number) {
    this.currentTime = position;
    this.emit('timeUpdate', { position, duration: 600, buffered: position });
  }
}

describe('EdlController', () => {
  let engine: FakeEngine;
  let active: boolean;
  let seeks: { to: number; at: number }[];
  let ends: number;
  let ctl: EdlController;
  const t0 = 1_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    engine = new FakeEngine();
    active = true;
    seeks = [];
    ends = 0;
    ctl = new EdlController({
      engine: () => engine as unknown as PlaybackEngine,
      active: () => active,
      duration: () => 600,
      seek: (to) => seeks.push({ to, at: Date.now() - t0 }),
      end: () => ends++,
    });
    ctl.attach(engine as unknown as PlaybackEngine);
  });

  afterEach(() => vi.useRealTimers());

  const cut = (start: number, end: number): EdlRange => ({ start, end, action: 'cut' });
  const commercial = (start: number, end: number): EdlRange => ({ start, end, action: 'commercial' });

  it('seeks within 30 ms of a boundary using 1 s ticks', () => {
    ctl.load(1, [cut(10.5, 20)]);
    engine.time(0);
    for (let s = 1; s <= 10; s++) {
      vi.advanceTimersByTime(1000);
      engine.time(s);
    }
    vi.advanceTimersByTime(1000);
    expect(seeks).toHaveLength(1);
    expect(seeks[0].to).toBe(20);
    expect(Math.abs(seeks[0].at - 10_500)).toBeLessThanOrEqual(30);
  });

  it('extrapolates with the playback rate', () => {
    engine.playbackRate = 2;
    ctl.load(1, [cut(10, 20)]);
    engine.time(0);
    vi.advanceTimersByTime(5000);
    expect(seeks).toHaveLength(1);
    expect(Math.abs(seeks[0].at - 5000)).toBeLessThanOrEqual(30);
  });

  it('is inert while the host says inactive', () => {
    active = false;
    ctl.load(1, [cut(10, 20)]);
    engine.time(9);
    vi.advanceTimersByTime(5000);
    engine.time(12);
    expect(seeks).toEqual([]);
    expect(ctl.resolveSeek(15)).toBe(15);
    expect(ctl.resolveStart(15)).toBe(15);
  });

  it('keeps a skipped commercial across a reload of the same file', () => {
    ctl.load(1, [commercial(100, 160)]);
    engine.time(101);
    expect(seeks.map((s) => s.to)).toEqual([160]);
    ctl.load(1, [commercial(100, 160)]);
    engine.time(101);
    expect(seeks).toHaveLength(1);
    ctl.load(2, [commercial(100, 160)]);
    ctl.settle();
    engine.time(101);
    expect(seeks).toHaveLength(2);
  });

  it('turns a tail range into a natural end, once', () => {
    ctl.load(1, [cut(590, 600)]);
    engine.time(591);
    engine.time(592);
    expect(ends).toBe(1);
    expect(seeks).toEqual([]);
  });

  it('sends a user seek into a cut to its end', () => {
    ctl.load(1, [cut(100, 150)]);
    expect(ctl.resolveSeek(120)).toBe(150);
    expect(ctl.notice()).toBe('cut');
    expect(ctl.resolveSeek(160)).toBe(160);
  });

  it('ends on a user seek into the tail', () => {
    ctl.load(1, [cut(590, 600)]);
    expect(ctl.resolveSeek(595)).toBeNull();
    expect(ends).toBe(1);
  });

  it('resolves the start position and passes mute ranges to the engine', () => {
    ctl.load(1, [cut(0, 30), { start: 50, end: 51, action: 'mute' }]);
    expect(ctl.resolveStart(5)).toBe(30);
    expect(engine.mutes.at(-1)).toEqual([{ start: 50, end: 51 }]);
    ctl.clear();
    expect(engine.mutes.at(-1)).toEqual([]);
  });

  it('does not arm a timer while paused or buffering', () => {
    ctl.load(1, [cut(10, 20)]);
    engine.paused = true;
    engine.time(9);
    vi.advanceTimersByTime(5000);
    expect(seeks).toEqual([]);
    engine.paused = false;
    engine.emit('stateChanged', { state: 'buffering' });
    vi.advanceTimersByTime(5000);
    expect(seeks).toEqual([]);
  });

  it('ignores stale positions right after its own seek', () => {
    ctl.load(1, [cut(10, 20), cut(15, 25)]);
    engine.time(11);
    expect(seeks.map((s) => s.to)).toEqual([25]);
    engine.time(11.5);
    expect(seeks).toHaveLength(1);
  });

  it('keeps skipped commercials across an inactive period and a timeline shift', () => {
    ctl.load(1, [commercial(40, 60)]);
    expect(ctl.resolveSeek(41)).toBe(60);
    active = false;
    ctl.load(1, [commercial(41.5, 61.5)]);
    active = true;
    ctl.load(1, [commercial(41.5, 61.5)]);
    expect(ctl.resolveSeek(45)).toBe(45);
  });

  it('pushes no mutes while inactive and restores them when active again', () => {
    active = false;
    ctl.load(1, [{ start: 5, end: 6, action: 'mute' }]);
    expect(engine.mutes.at(-1)).toEqual([]);
    active = true;
    engine.time(1);
    expect(engine.mutes.at(-1)).toEqual([{ start: 5, end: 6 }]);
  });

  it('resolveSeek clears a pending skip target', () => {
    ctl.load(1, [cut(10, 20), cut(30, 40)]);
    engine.time(9.9);
    vi.advanceTimersByTime(200);
    expect(seeks).toHaveLength(1);
    expect(ctl.resolveSeek(3)).toBe(3);
    engine.time(3);
    engine.time(30.5);
    expect(seeks).toHaveLength(2);
  });

  it('does not seek the same target twice within 3 s', () => {
    ctl.load(1, [cut(10, 20)]);
    engine.time(10.5);
    expect(seeks).toHaveLength(1);
    engine.time(10.6);
    expect(seeks).toHaveLength(1);
  });

  it('ignores the old file position reports until the new load settles', () => {
    ctl.load(1, []);
    ctl.load(2, [cut(10, 20)]);
    engine.time(12);
    expect(seeks).toEqual([]);
    ctl.settle();
    engine.time(12);
    expect(seeks).toHaveLength(1);
  });

  it('manual mode: shows the cue, never auto-skips, skipCommercial seeks to the end', () => {
    ctl.setAutoSkipCommercials(false);
    ctl.load(1, [commercial(100, 160), cut(160, 170)]);
    engine.time(50);
    expect(ctl.commercialCue()).toBeNull();
    engine.time(101);
    vi.advanceTimersByTime(5000);
    expect(seeks).toEqual([]);
    expect(ctl.commercialCue()).toEqual({ fileId: 1, index: 0, start: 100, end: 160 });
    expect(ctl.skipCommercial()).toBe(170);
    expect(ctl.commercialCue()).toBeNull();
    expect(ctl.notice()).toBeNull();
    engine.time(120);
    expect(ctl.commercialCue()).toBeNull();
  });

  it('manual mode: a file change drops the cue and the next file reveals its own', () => {
    ctl.setAutoSkipCommercials(false);
    ctl.load(1, [commercial(100, 160)]);
    engine.time(120);
    expect(ctl.commercialCue()?.fileId).toBe(1);
    ctl.load(2, [commercial(100, 160)]);
    expect(ctl.commercialCue()).toBeNull();
    ctl.settle();
    engine.time(120);
    expect(ctl.commercialCue()).toEqual({ fileId: 2, index: 0, start: 100, end: 160 });
  });

  it('manual mode: no cue in the tail, and switching back to auto clears it', () => {
    ctl.setAutoSkipCommercials(false);
    ctl.load(1, [commercial(100, 160)]);
    engine.time(159.5);
    expect(ctl.commercialCue()).toBeNull();
    engine.time(120);
    expect(ctl.commercialCue()).not.toBeNull();
    ctl.setAutoSkipCommercials(true);
    expect(ctl.commercialCue()).toBeNull();
  });

  it('does not re-sample a stale engine position on rearm', () => {
    ctl.load(1, [cut(10, 20)]);
    engine.time(8);
    vi.advanceTimersByTime(1000);
    engine.currentTime = 0;
    ctl.rearm();
    vi.advanceTimersByTime(1100);
    expect(seeks).toHaveLength(1);
  });
});
