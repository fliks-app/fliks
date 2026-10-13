import { describe, expect, it } from 'vitest';
import type { QoeDeviceSummary } from '../../core/services/api/qoe-api.service';
import { mergeDevices } from './qoe-devices';

const row = (device: string, o: Partial<QoeDeviceSummary> = {}): QoeDeviceSummary => ({
  device,
  systemName: null,
  engine: 'shaka',
  sessions: 1,
  stallSessions: 0,
  avgDroppedPct: null,
  hwDecoderPct: null,
  topVerdict: 'ok',
  ...o,
});
const label = (r: QoeDeviceSummary) => (r.device?.includes('Chrome') ? 'Chrome on Linux' : r.device ?? '-');

describe('mergeDevices', () => {
  it('merges browser versions into one device, weighting the averages by playbacks', () => {
    const merged = mergeDevices(
      [
        row('Chrome/120', { sessions: 3, stallSessions: 1, avgDroppedPct: 1, topVerdict: 'unknown' }),
        row('Chrome/121', { sessions: 1, avgDroppedPct: 5, topVerdict: 'network' }),
      ],
      label,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ label: 'Chrome on Linux', raw: ['Chrome/120', 'Chrome/121'], sessions: 4, stallSessions: 1, avgDroppedPct: 2, topVerdict: 'network' });
  });

  it('keeps engines apart', () => {
    expect(mergeDevices([row('Chrome/120'), row('Chrome/121', { engine: 'cast' })], label)).toHaveLength(2);
  });
});
