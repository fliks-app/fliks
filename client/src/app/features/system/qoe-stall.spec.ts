import { describe, expect, it } from 'vitest';
import { durationParts, eventStartMs, stallBreakdown, stallExplanation } from './qoe-stall';
import { qoeDotClass } from './qoe-health';

const stall = (data: object) => ({ type: 'stall' as const, data });

describe('stallExplanation', () => {
  it('maps the evidence to display units', () => {
    const r = stallExplanation(
      stall({
        cause: 'network',
        causeReason: 'qoe.stall.network_starved',
        causeEvidence: { bufferAheadS: 0.44, bandwidthBps: 1.9e6, variantBitrate: 5.5e6 },
      }),
    );
    expect(r).toEqual({
      key: 'qoe.stall.network_starved',
      params: expect.objectContaining({ buffer: '0.4', throughput: '1.9', bitrate: '5.5' }),
    });
  });

  it('formats the server wait in seconds and the dropped share as a rounded percent', () => {
    const r = stallExplanation(
      stall({ cause: 'server', causeReason: 'qoe.stall.server_wait', causeEvidence: { waitedMs: 3200, transcodeSpeed: 0.74, droppedPct: 15.4 } }),
    );
    expect(r?.params).toMatchObject({ wait: '3.2', speed: '0.7', dropped: '15' });
  });

  it('is null for a stall recorded before causes existed', () => {
    expect(stallExplanation(stall({ durationMs: 1000 }))).toBeNull();
  });
});

describe('durations and times', () => {
  it('writes a duration as units, never as a clock', () => {
    expect(durationParts(129_000)).toEqual({ key: 'qoe.duration_min', params: { min: '2', sec: '09' } });
    expect(durationParts(9_600)).toEqual({ key: 'qoe.duration_s', params: { sec: '10' } });
    expect(durationParts(3_900_000)).toEqual({ key: 'qoe.duration_h', params: { h: '1', min: '5' } });
  });

  it('dates a stall by its start, since it is reported at its end', () => {
    expect(eventStartMs({ at: 100_000, type: 'stall', data: { durationMs: 9_600 } })).toBe(90_400);
    expect(eventStartMs({ at: 100_000, type: 'error', data: { durationMs: 9_600 } })).toBe(100_000);
  });

  it('formats the evidence numbers with the given locale formatter', () => {
    const r = stallExplanation(
      { data: { cause: 'network', causeReason: 'qoe.stall.network_starved', causeEvidence: { bufferAheadS: 0.5 } } },
      (v, d = 1) => v.toFixed(d).replace('.', ','),
    );
    expect(r?.params['buffer']).toBe('0,5');
  });
});

describe('one palette', () => {
  it('colours a verdict like the cause of the same name', () => {
    const v = (verdict: any) => qoeDotClass({ verdict, confidence: 'high', reasons: [] });
    expect(v('network')).toBe('bg-warning');
    expect(v('server')).toBe('bg-error');
    expect(v('device')).toBe('bg-info');
    expect(v('unknown')).toBe('bg-base-content/30');
  });
});

describe('stallBreakdown', () => {
  it('counts and sums per cause in a fixed order, ignoring other events and unclassified stalls', () => {
    const r = stallBreakdown([
      stall({ cause: 'network', durationMs: 2000 }),
      stall({ cause: 'server', durationMs: 3000 }),
      stall({ cause: 'network', durationMs: 500 }),
      stall({ durationMs: 9000 }),
      { type: 'error' as const, data: { cause: 'device' } },
    ]);
    expect(r).toEqual([
      { cause: 'server', count: 1, ms: 3000 },
      { cause: 'network', count: 2, ms: 2500 },
    ]);
  });
});
