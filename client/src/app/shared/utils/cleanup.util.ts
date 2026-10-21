import { TranslateService } from '@ngx-translate/core';
import { CleanupCriteria } from '../../core/services/api/cleanup-api.service';
import { Season } from '../../core/services/api/media.service';

const DAY_MS = 86_400_000;

/** Whole days until `deleteAt`, rounded up so the last partial day still reads as 1; never negative. */
export function daysLeft(deleteAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(deleteAt) - now) / DAY_MS));
}

export function leavingLabel(translate: TranslateService, deleteAt: string): string {
  const count = daysLeft(deleteAt);
  if (count === 0) return translate.instant('cleanup.leaving_today');
  return translate.instant(count === 1 ? 'cleanup.leaving_in_one' : 'cleanup.leaving_in_other', { count });
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ` S02` or ` S02E05` for a season or episode candidate, empty for a whole media. */
export function scopeLabel(c: { seasonNumber: number | null; episodeNumber: number | null }): string {
  if (c.seasonNumber == null) return '';
  return c.episodeNumber == null ? ` S${pad(c.seasonNumber)}` : ` S${pad(c.seasonNumber)}E${pad(c.episodeNumber)}`;
}

/** Badges for the seasons and episodes of a series flagged for cleanup with a date. */
export function scopedLeavingLabels(translate: TranslateService, seasons: Season[]): string[] {
  const labels: string[] = [];
  const episodes: string[] = [];
  for (const s of seasons) {
    if (s.deleteAt) {
      labels.push(translate.instant('cleanup.season_badge', { season: s.seasonNumber, label: leavingLabel(translate, s.deleteAt) }));
    } else {
      for (const e of s.episodes) if (e.deleteAt) episodes.push(e.deleteAt);
    }
  }
  if (episodes.length) {
    const soonest = episodes.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
    labels.push(translate.instant('cleanup.episodes_badge', { count: episodes.length, label: leavingLabel(translate, soonest) }));
  }
  return labels;
}

/** Drops unset fields and a `minVotes` without `ratingBelow`, which the server rejects. */
export function cleanCriteria(c: CleanupCriteria): CleanupCriteria {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined || v === null || v === false || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  if (out['ratingBelow'] === undefined) delete out['minVotes'];
  return out as CleanupCriteria;
}
