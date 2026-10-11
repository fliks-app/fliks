import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MuteGate } from './mute-gate';

describe('MuteGate', () => {
  let pos: number;
  let rate: number;
  let paused: boolean;
  let applied: boolean[];
  let gate: MuteGate;
  let started: number;

  const clock = () => (paused ? pos : pos + ((Date.now() - started) / 1000) * rate);
  const play = () => { pos = clock(); started = Date.now(); paused = false; };

  beforeEach(() => {
    vi.useFakeTimers();
    pos = 0; rate = 1; paused = true; applied = []; started = Date.now();
    gate = new MuteGate({ position: clock, rate: () => rate, paused: () => paused, apply: (m) => applied.push(m), leadS: 0.03 });
  });
  afterEach(() => vi.useRealTimers());

  it('mutes at the range start and unmutes at its end while playing', () => {
    gate.setRanges([{ start: 20, end: 21 }]);
    pos = 19; play(); gate.sync();
    vi.advanceTimersByTime(1000);
    expect(applied).toEqual([true]);
    vi.advanceTimersByTime(1000);
    expect(applied).toEqual([true, false]);
  });
  it('is correct after a seek into and out of a range', () => {
    gate.setRanges([{ start: 20, end: 21 }]);
    play(); gate.sync(20.5);
    expect(applied).toEqual([true]);
    pos = 2; started = Date.now(); gate.sync();
    expect(applied).toEqual([true, false]);
  });
  it('holds while paused and resumes timing on play', () => {
    gate.setRanges([{ start: 20, end: 21 }]);
    pos = 20.5; gate.sync();
    expect(applied).toEqual([true]);
    vi.advanceTimersByTime(5000);
    expect(applied).toEqual([true]);
    play(); gate.sync();
    vi.advanceTimersByTime(600);
    expect(applied).toEqual([true, false]);
  });
  it('scales the timer by the playback rate', () => {
    rate = 2; gate.setRanges([{ start: 20, end: 21 }]);
    pos = 18; play(); gate.sync();
    vi.advanceTimersByTime(1000);
    expect(applied).toEqual([true]);
  });
  it('bridges small gaps and clears on [] and dispose', () => {
    gate.setRanges([{ start: 10, end: 11 }, { start: 11.1, end: 12 }]);
    pos = 10.5; gate.sync();
    pos = 11.05; gate.sync();
    expect(applied).toEqual([true]);
    gate.setRanges([]);
    expect(applied).toEqual([true, false]);
    pos = 1; gate.setRanges([{ start: 0, end: 5 }]);
    gate.dispose();
    expect(applied).toEqual([true, false, true, false]);
    vi.advanceTimersByTime(10000);
    expect(applied).toHaveLength(4);
  });
  it('stays muted until the range end, not lead early', () => {
    gate.setRanges([{ start: 20, end: 21 }]);
    pos = 20.5; gate.sync();
    expect(applied).toEqual([true]);
    pos = 20.98; gate.sync();
    expect(applied).toEqual([true]);
    pos = 21; gate.sync();
    expect(applied).toEqual([true, false]);
  });
  it('mutes from start - lead and holds the trail', () => {
    gate.dispose();
    gate = new MuteGate({ position: clock, rate: () => rate, paused: () => paused, apply: (m) => applied.push(m), leadS: 0.05, trailS: 0.05 });
    gate.setRanges([{ start: 20, end: 21 }]);
    pos = 19.94; gate.sync();
    expect(applied).toEqual([]);
    pos = 19.96; gate.sync();
    pos = 21.04; gate.sync();
    expect(applied).toEqual([true]);
    pos = 21.06; gate.sync();
    expect(applied).toEqual([true, false]);
  });
});
