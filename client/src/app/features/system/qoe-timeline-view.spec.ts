import { describe, expect, it } from 'vitest';
import type { QoeSessionRow } from '../../core/services/api/qoe-api.service';
import { blockSummary, blockTitle, clockLabel, detailsOpen, formatPosition } from './qoe-timeline-view';
import type { TimelineTransition } from './qoe-timeline';

const f = {
  t: (k: string, p?: Record<string, string>) => `${k}${p ? JSON.stringify(p) : ''}`,
  n: (v: number, d = 1) => v.toFixed(d),
};
const s = (o: Partial<QoeSessionRow> & { served?: string } = {}) =>
  ({ quality: 'auto', engine: 'shaka', pipeline: { output: { quality: o.served ?? null, requested: 'auto' } }, ...o }) as QoeSessionRow;
const tr = (kind: TimelineTransition['kind']) => ({ kind }) as TimelineTransition;

describe('blockTitle', () => {
  it('names the start, the rung, cast and recovery in plain words', () => {
    expect(blockTitle(s(), true, null, f)).toBe('qoe.block.title_start_auto');
    expect(blockTitle(s({ quality: '720p', served: '720p' }), true, null, f)).toBe('qoe.block.title_start{"rung":"720p"}');
    expect(blockTitle(s({ served: '2160p' }), false, tr('quality_switch'), f)).toBe('qoe.block.title_play{"rung":"2160p"}');
    expect(blockTitle(s(), false, tr('next'), f)).toBe('qoe.block.title_play_auto');
    expect(blockTitle(s({ engine: 'cast' }), false, tr('handoff'), f)).toBe('qoe.block.title_cast');
    expect(blockTitle(s(), false, tr('recovery'), f)).toBe('qoe.block.title_recovery');
  });
});

describe('blockSummary', () => {
  it('says nothing happened plainly, without zeros', () => {
    expect(blockSummary({ watchedMs: 60_000, stallCount: 0, stallMs: 0 }, f)).toBe('qoe.duration_min{"min":"1","sec":"00"} · qoe.block.none');
  });

  it('calls a session under 5 s a few seconds', () => {
    expect(blockSummary({ watchedMs: 3000, stallCount: 0, stallMs: 0 }, f)).toBe('qoe.block.few_seconds · qoe.block.none');
  });

  it('counts stalls with their total, singular apart', () => {
    expect(blockSummary({ watchedMs: null, stallCount: 1, stallMs: 9600 }, f)).toContain('qoe.block.stalls_one');
    expect(blockSummary({ watchedMs: 129_000, stallCount: 2, stallMs: 11_500 }, f)).toContain('"count":"2"');
  });
});

describe('helpers', () => {
  it('opens details for server and device verdicts only', () => {
    expect(['server', 'device', 'network', 'ok', 'error', 'unknown'].map((v) => detailsOpen(v as never))).toEqual([true, true, false, false, false, false]);
  });

  it('formats positions', () => {
    expect(formatPosition(197)).toBe('3:17');
    expect(formatPosition(null)).toBe('-');
  });

  it('shows the date only across midnight', () => {
    const start = new Date(2026, 9, 13, 23, 59, 0).getTime();
    expect(clockLabel(start + 1000, start, 'en-GB')).toBe('23:59:01');
    expect(clockLabel(start + 120_000, start, 'en-GB')).toBe('14/10/2026 00:01:00');
  });
});
