import type { QoeEventRow, QoeSessionRow } from '../../core/services/api/qoe-api.service';
import { eventStartMs, rungDisplay, type Fmt } from './qoe-stall';
import { rungOf, type Timeline, type TimelineBlock, type TimelineTransition } from './qoe-timeline';

/** Plain-words title of a session block, from how it started and what it served. */
export function blockTitle(s: QoeSessionRow, first: boolean, f: Fmt): string {
  if (s.engine === 'cast') return f.t('qoe.block.title_cast');
  const r = rungOf(s);
  const rung = r.rung ? rungDisplay(r.rung, f) : '';
  if (first) return rung ? f.t('qoe.block.title_start', { rung }) : f.t('qoe.block.title_start_auto');
  return rung ? f.t('qoe.block.title_play', { rung }) : f.t('qoe.block.title_play_auto');
}

/** "aucune coupure", "2 coupures, 11,5 s au total". */
export function blockSummary(s: Pick<QoeSessionRow, 'stallCount' | 'stallMs'>, f: Fmt): string {
  const total = f.t('qoe.seconds', { value: f.n(s.stallMs / 1000, 1) });
  return s.stallCount === 0
    ? f.t('qoe.block.none')
    : f.t(s.stallCount === 1 ? 'qoe.block.stalls_one' : 'qoe.block.stalls_many', { count: String(s.stallCount), total });
}

/** The technical details are opened for a block whose cause lies on the server or the device. */
export const detailsOpen = (verdict: QoeSessionRow['verdict']) => verdict === 'server' || verdict === 'device';

/** `m:ss` position in the video. */
export function formatPosition(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return '-';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** HH:MM:SS; the date is added only when the instant falls on another day than the playback start. */
export function clockLabel(ms: number, startMs: number, lang: string): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(lang, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return d.toDateString() === new Date(startMs).toDateString() ? time : `${d.toLocaleDateString(lang, { dateStyle: 'short' })} ${time}`;
}

/** One line of the rail: every kind shares the marker, time and content columns. */
export type TimelineStep =
  | {
      kind: 'session';
      at: number;
      block: TimelineBlock;
      index: number;
      incoming: TimelineTransition | null;
      /** Until the next session or the end; null while the last one is still playing. */
      spanMs: number | null;
    }
  | { kind: 'event'; at: number; event: QoeEventRow }
  | { kind: 'end'; at: number | null };

/**
 * The rail in time order: each session, then its events by start. What opened a session (a quality change, a
 * recovery…) happens at its start, so it is part of the session's step rather than a step of its own.
 */
export function timelineSteps(tl: Timeline, endMs: number | null): TimelineStep[] {
  const steps: TimelineStep[] = [];
  tl.blocks.forEach((block, index) => {
    const incoming = index > 0 ? tl.transitions[index - 1] : null;
    const at = Date.parse(block.session.startedAt);
    const until = index + 1 < tl.blocks.length ? Date.parse(tl.blocks[index + 1].session.startedAt) : endMs;
    steps.push({ kind: 'session', at, block, index, incoming, spanMs: until == null ? null : Math.max(0, until - at) });
    const events = [...block.events].sort((a, b) => eventStartMs(a) - eventStartMs(b));
    for (const event of events) steps.push({ kind: 'event', at: eventStartMs(event), event });
  });
  steps.push({ kind: 'end', at: endMs });
  return steps;
}

/** The freeze before the recovery that opened this session; the session counts it among its stalls. */
export function incomingWaitMs(incoming: TimelineTransition | null): number {
  return incoming?.kind === 'recovery' ? (incoming.event?.data?.durationMs ?? 0) : 0;
}

/** The session's stall counters minus the recovery wait its opening already shows. */
export function ownStalls(b: TimelineBlock, incoming: TimelineTransition | null): { stallCount: number; stallMs: number } {
  const wait = incomingWaitMs(incoming);
  if (wait <= 0) return { stallCount: b.session.stallCount, stallMs: b.session.stallMs };
  return { stallCount: Math.max(0, b.session.stallCount - 1), stallMs: Math.max(0, b.session.stallMs - wait) };
}

/** Stalls the session counted but never described with an event (an older client, or events lost). */
export function unreportedStalls(b: TimelineBlock, incoming: TimelineTransition | null = null): { count: number; ms: number } | null {
  const own = ownStalls(b, incoming);
  const reported = b.events.filter((e) => e.type === 'stall' || (e.type === 'recovery' && (e.data?.durationMs ?? 0) > 0));
  const count = own.stallCount - reported.length;
  if (count <= 0) return null;
  const reportedMs = reported.reduce((n, e) => n + (e.data?.durationMs ?? 0), 0);
  return { count, ms: Math.max(0, own.stallMs - reportedMs) };
}
