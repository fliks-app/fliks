import { TranslateService } from '@ngx-translate/core';
import { CleanupCriteria } from '../../core/services/api/cleanup-api.service';

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
