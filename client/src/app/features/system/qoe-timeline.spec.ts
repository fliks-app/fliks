import { describe, expect, it } from 'vitest';
import type { QoeEventRow, QoeSessionRow } from '../../core/services/api/qoe-api.service';
import { buildTimeline, isOngoing, rungOf } from './qoe-timeline';

const session = (id: string, o: Partial<QoeSessionRow> & { served?: string | null; requested?: string } = {}): QoeSessionRow => {
  const { served, requested, ...rest } = o;
  return {
    sessionId: id,
    quality: 'auto',
    engine: 'shaka',
    pipeline: { source: null, output: { codec: 'h264', hdr: null, quality: served ?? null, bitrate: null, requested: requested ?? 'auto' } } as never,
    ...rest,
  } as QoeSessionRow;
};
const ev = (sessionId: string, type: QoeEventRow['type'], at: number, data: QoeEventRow['data'] = {}): QoeEventRow => ({
  id: at,
  sessionId,
  at,
  type,
  data,
});

describe('rungOf', () => {
  it('never reports auto as a served rung', () => {
    expect(rungOf(session('a', { served: '2160p-hdr' }))).toEqual({ auto: true, rung: '2160p' });
    expect(rungOf(session('a', { served: 'auto' }))).toEqual({ auto: true, rung: null });
    expect(rungOf(session('a'))).toEqual({ auto: true, rung: null });
  });

  it('keeps a requested rung', () => {
    expect(rungOf(session('a', { quality: '720p', served: '720p' }))).toEqual({ auto: false, rung: '720p' });
    expect(rungOf(session('a', { quality: '720p' }))).toEqual({ auto: false, rung: '720p' });
  });
});

describe('buildTimeline', () => {
  it('is empty without sessions', () => {
    expect(buildTimeline([], [])).toEqual({ blocks: [], transitions: [] });
  });

  it('groups events under their session and keeps the first block marked', () => {
    const t = buildTimeline([session('a'), session('b')], [ev('a', 'stall', 1), ev('b', 'error', 5), ev('a', 'stall', 2)]);
    expect(t.blocks.map((b) => [b.first, b.events.map((e) => e.at)])).toEqual([
      [true, [1, 2]],
      [false, [5]],
    ]);
  });

  it('turns the quality switch that ended a session into the transition, with rungs and bitrates', () => {
    const switchEv = ev('a', 'quality_switch', 10, { fromBitrate: 30_900_000, toBitrate: 20_200_000 });
    const t = buildTimeline([session('a'), session('b', { served: '2160p' })], [ev('a', 'stall', 3), switchEv]);
    expect(t.blocks[0].events.map((e) => e.type)).toEqual(['stall']);
    expect(t.transitions[0]).toMatchObject({
      kind: 'quality_switch',
      from: { auto: true, rung: null },
      to: { auto: true, rung: '2160p' },
      fromBitrate: 30_900_000,
      toBitrate: 20_200_000,
    });
  });

  it('reads a recovery as the transition, and a hand-off when the next session is on a cast receiver', () => {
    const r = buildTimeline([session('a'), session('b')], [ev('a', 'recovery', 4)]);
    expect(r.transitions[0].kind).toBe('recovery');
    const c = buildTimeline([session('a'), session('b', { engine: 'cast' })], []);
    expect(c.transitions[0]).toMatchObject({ kind: 'handoff', event: null });
    expect(buildTimeline([session('a'), session('b')], []).transitions[0].kind).toBe('next');
  });

  it('files an event of an unknown session under the last block', () => {
    const t = buildTimeline([session('a'), session('b')], [ev('zzz', 'error', 1)]);
    expect(t.blocks[1].events).toHaveLength(1);
  });
});

describe('isOngoing', () => {
  it('is a playback not ended and seen in the last two minutes', () => {
    const now = Date.parse('2026-01-01T00:10:00Z');
    expect(isOngoing({ endedAt: null, lastSeenAt: '2026-01-01T00:09:00Z' }, now)).toBe(true);
    expect(isOngoing({ endedAt: null, lastSeenAt: '2026-01-01T00:05:00Z' }, now)).toBe(false);
    expect(isOngoing({ endedAt: '2026-01-01T00:09:30Z', lastSeenAt: '2026-01-01T00:09:30Z' }, now)).toBe(false);
  });
});
