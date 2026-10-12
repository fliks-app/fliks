import { describe, expect, it } from 'vitest';
import { stallBreakdown, stallExplanation } from './qoe-stall';

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
