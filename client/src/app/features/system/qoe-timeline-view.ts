import type { QoeSessionRow } from '../../core/services/api/qoe-api.service';
import { durationParts, type Fmt } from './qoe-stall';
import { rungOf, type TimelineTransition } from './qoe-timeline';

const SHORT_MS = 5000;

/** Plain-words title of a session block, from how it started and what it served. */
export function blockTitle(s: QoeSessionRow, first: boolean, incoming: TimelineTransition | null, f: Fmt): string {
  if (s.engine === 'cast') return f.t('qoe.block.title_cast');
  if (incoming?.kind === 'recovery') return f.t('qoe.block.title_recovery');
  const r = rungOf(s);
  const rung = r.rung ?? '';
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
