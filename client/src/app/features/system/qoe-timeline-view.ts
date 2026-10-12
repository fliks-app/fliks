import type { QoeEventRow, QoeSessionRow } from '../../core/services/api/qoe-api.service';
import { durationParts, eventStartMs, rungDisplay, type Fmt } from './qoe-stall';
import { rungOf, type Timeline, type TimelineBlock, type TimelineTransition } from './qoe-timeline';

const SHORT_MS = 5000;

/** Plain-words title of a session block, from how it started and what it served. */
export function blockTitle(s: QoeSessionRow, first: boolean, incoming: TimelineTransition | null, f: Fmt): string {
  if (s.engine === 'cast') return f.t('qoe.block.title_cast');
  if (incoming?.kind === 'recovery') return f.t('qoe.block.title_recovery');
  const r = rungOf(s);
  const rung = r.rung ? rungDisplay(r.rung, f) : '';
  if (first) return rung ? f.t('qoe.block.title_start', { rung }) : f.t('qoe.block.title_start_auto');
  return rung ? f.t('qoe.block.title_play', { rung }) : f.t('qoe.block.title_play_auto');
}

/** "1 min 00 s · aucune coupure"; a session under 5 s says "quelques secondes" rather than a number. */
export function blockSummary(s: Pick<QoeSessionRow, 'watchedMs' | 'stallCount' | 'stallMs'>, f: Fmt): string {
  const parts: string[] = [];
  if (s.watchedMs != null) {
    const d = durationParts(s.watchedMs);
    parts.push(s.watchedMs < SHORT_MS ? f.t('qoe.block.few_seconds') : f.t(d.key, d.params));
  }
  const total = f.t('qoe.seconds', { value: f.n(s.stallMs / 1000, 1) });
  parts.push(
    s.stallCount === 0
      ? f.t('qoe.block.none')
      : f.t(s.stallCount === 1 ? 'qoe.block.stalls_one' : 'qoe.block.stalls_many', { count: String(s.stallCount), total }),
  );
  return parts.join(' · ');
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
  | { kind: 'session'; at: number; block: TimelineBlock; index: number }
  | { kind: 'event'; at: number; event: QoeEventRow }
  | { kind: 'transition'; at: number; transition: TimelineTransition }
  | { kind: 'end'; at: number | null };

/** The rail in time order: each session, then its events by start, then what led to the next session. */
export function timelineSteps(tl: Timeline, endMs: number | null): TimelineStep[] {
  const steps: TimelineStep[] = [];
  tl.blocks.forEach((block, index) => {
    steps.push({ kind: 'session', at: Date.parse(block.session.startedAt), block, index });
    const events = [...block.events].sort((a, b) => eventStartMs(a) - eventStartMs(b));
    for (const event of events) steps.push({ kind: 'event', at: eventStartMs(event), event });
    const transition = tl.transitions[index];
    if (transition) {
      const at = transition.event ? eventStartMs(transition.event) : Date.parse(tl.blocks[index + 1].session.startedAt);
      steps.push({ kind: 'transition', at, transition });
    }
  });
  steps.push({ kind: 'end', at: endMs });
  return steps;
}

/** Stalls the session counted but never described with an event (an older client, or events lost). */
export function unreportedStalls(b: TimelineBlock): { count: number; ms: number } | null {
  const reported = b.events.filter((e) => e.type === 'stall');
  const count = b.session.stallCount - reported.length;
  if (count <= 0) return null;
  const reportedMs = reported.reduce((n, e) => n + (e.data?.durationMs ?? 0), 0);
  return { count, ms: Math.max(0, b.session.stallMs - reportedMs) };
}
