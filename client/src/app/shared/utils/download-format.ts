/** Shared download-progress formatting + state mapping, used by the Activity
 *  queue, the request rows, and media-detail so the numbers and the
 *  progress-bar colour are rendered identically everywhere. */

import type { ProgressPhase } from '../../core/enums/download-progress-state.enum';
import type {
  DownloadLeaf,
  LeafKey,
  MediaDownloadProgress,
} from '../../core/services/download-progress.service';

export type ProgressVariant =
  | 'primary'
  | 'success'
  | 'warning'
  | 'error'
  | 'neutral';

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number): string {
  // 8640000s (100 days) is the "infinite" ETA sentinel a stalled download reports —
  // show ∞ rather than a bogus "2400h 0m".
  if (!isFinite(seconds) || seconds >= 8640000) return '∞';
  if (seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Closed-state → progress-bar colour variant. */
const VARIANT_BY_STATE: Record<ProgressPhase, ProgressVariant> = {
  queued: 'warning',
  active: 'primary',
  stalled: 'warning',
  paused: 'neutral',
  importing: 'success',
  searching: 'neutral',
};

/** Colour variant for a state; '' (no in-flight leaf) reads as `primary`. */
export function qbStateVariant(state: ProgressPhase | ''): ProgressVariant {
  return state ? VARIANT_BY_STATE[state] : 'primary';
}

/** Closed-state → `activity.*` i18n key. */
const LABEL_KEY_BY_STATE: Record<ProgressPhase, string> = {
  queued: 'activity.tstatus_queued',
  active: 'activity.tstatus_downloading',
  stalled: 'activity.tstatus_stalled',
  paused: 'activity.tstatus_paused',
  importing: 'activity.fstatus_importing',
  searching: 'activity.tstatus_searching',
};

export function qbStateLabelKey(state: ProgressPhase | ''): string {
  return state ? LABEL_KEY_BY_STATE[state] : 'activity.tstatus_unknown';
}

const VARIANT_BADGE_CLASS: Record<ProgressVariant, string> = {
  primary: 'badge-info',
  success: 'badge-success',
  warning: 'badge-warning',
  error: 'badge-error',
  neutral: 'badge-ghost',
};

/** State → daisyUI badge colour class (via {@link qbStateVariant}). */
export function qbStateBadgeClass(state: ProgressPhase | ''): string {
  return VARIANT_BADGE_CLASS[qbStateVariant(state)];
}

// Precedence for folding several concurrent leaves into one status, most
// prominent first. `stalled` absorbs what used to be the vendor's dedicated
// error states, so it still outranks `active` the way a real failure did;
// otherwise the most-active state wins. The per-leaf breakdown lives in the
// detail modal.
const STATE_RANK: Record<ProgressPhase, number> = {
  stalled: 1,
  active: 2,
  queued: 3,
  importing: 4,
  paused: 5,
  // Last: any download that actually exists says more than "still looking".
  searching: 6,
};

/** Representative state for a set of concurrent leaves (see STATE_RANK).
 *  Returns '' for an empty set (no in-flight leaf). */
export function dominantState(
  states: ProgressPhase[],
): ProgressPhase | '' {
  let best: ProgressPhase | '' = '';
  let bestRank = Infinity;
  for (const s of states) {
    const r = STATE_RANK[s];
    if (r < bestRank) {
      bestRank = r;
      best = s;
    }
  }
  return best;
}

/** Mean percent over the still-downloading leaves only — a leaf already at 100%
 *  is excluded (rounding can land a near-complete leaf there just before the
 *  store retires it), so a finishing pack never shows a misleading
 *  "downloading 96%". Null when nothing is actively downloading. */
export function activeWeightedPercent(leaves: DownloadLeaf[]): number | null {
  // A leaf still being searched for has no size and no progress — counting its
  // 0 would drag a real download's percent down and label a lone search "0%".
  const active = leaves.filter((l) => l.state !== 'searching' && l.percent < 100);
  if (!active.length) return null;
  return Math.round(active.reduce((a, l) => a + l.percent, 0) / active.length);
}

export interface LeafFold {
  state: ProgressPhase | '';
  percent: number | null;
}

/** Fold a set of leaves into one status — dominant state + active percent +
 *  counts. The single aggregation primitive reused by the progress store, the
 *  badge descriptor and the detail modal. */
export function foldLeaves(leaves: DownloadLeaf[]): LeafFold {
  return {
    state: dominantState(leaves.map((l) => l.state)),
    percent: activeWeightedPercent(leaves),
  };
}

export interface DownloadBadgeDescriptor {
  /** ngx-translate key for the badge, or null to render nothing. */
  labelKey: string | null;
  badgeClass: string;
  percent: number | null;
  /** True iff there is ≥1 in-flight leaf in scope (so the modal has content). */
  isClickable: boolean;
  /** A search has no percentage to fill the badge with, so it says nothing is happening. The
   *  spinner is what carries that it is. */
  busy: boolean;
}

function fallbackDescriptor(
  monitored: boolean,
  downloaded: boolean,
): DownloadBadgeDescriptor {
  const base = { percent: null, isClickable: false, busy: false };
  if (downloaded) return { ...base, labelKey: null, badgeClass: '' };
  return monitored
    ? { ...base, labelKey: 'requests.badge_monitored', badgeClass: 'badge-info' }
    : { ...base, labelKey: 'requests.badge_unmonitored', badgeClass: 'badge-ghost' };
}

/** A leaf with the scope it was found under, for callers that render one row
 *  per download rather than a fold. */
export interface ScopedLeaf {
  seasonNumber: number;
  key: LeafKey;
  leaf: DownloadLeaf;
}

export function collectScopedLeaves(
  progress: MediaDownloadProgress,
  seasonFilter?: number[],
  episodeFilter?: number,
): ScopedLeaf[] {
  if (!progress.seasons) return [];
  const out: ScopedLeaf[] = [];
  for (const [seasonNumber, sp] of progress.seasons) {
    if (seasonFilter?.length && !seasonFilter.includes(seasonNumber)) continue;
    for (const [key, leaf] of sp.leaves) {
      // Only another episode's own download is out of scope. A leaf naming no
      // episode — a season pack, or one whose episode couldn't be resolved —
      // may well carry this one, so it counts.
      if (
        episodeFilter != null &&
        leaf.episodeNumber != null &&
        leaf.episodeNumber !== episodeFilter
      ) {
        continue;
      }
      out.push({ seasonNumber, key, leaf });
    }
  }
  return out;
}

function collectLeaves(
  progress: MediaDownloadProgress,
  seasonFilter?: number[],
  episodeFilter?: number,
): DownloadLeaf[] {
  return collectScopedLeaves(progress, seasonFilter, episodeFilter).map((s) => s.leaf);
}

/**
 * Single source of truth for what a status badge shows for a media (optionally
 * narrowed to a set of seasons, e.g. a per-season request). Owns only the
 * download / monitored / unmonitored / hide-when-downloaded sub-states — the
 * request lifecycle states (pending, declined, available…) stay in the request
 * component, which calls this only for in-flight scopes.
 */
export function describeBadge(
  progress: MediaDownloadProgress | null,
  opts: {
    monitored: boolean;
    downloaded: boolean;
    seasonFilter?: number[];
    /** Narrow to one episode — its own download, or a pack that contains it. */
    episodeFilter?: number;
  },
): DownloadBadgeDescriptor {
  return (
    describeDownload(progress, opts) ??
    fallbackDescriptor(opts.monitored, opts.downloaded)
  );
}

/**
 * The in-flight half of {@link describeBadge}: what a scope's downloads are
 * doing, or null when none of them are. Callers that only surface downloads
 * (the media header) use this directly — the monitored / unmonitored fallback
 * is a request-view concern and would otherwise sit on an ongoing series for
 * the life of the show.
 */
export function describeDownload(
  progress: MediaDownloadProgress | null,
  scope: {
    seasonFilter?: number[];
    /** Narrow to one episode — its own download, or a pack that contains it. */
    episodeFilter?: number;
  } = {},
): DownloadBadgeDescriptor | null {
  if (!progress) return null;

  let fold: LeafFold;
  if (
    progress.seasons &&
    (scope.seasonFilter?.length || scope.episodeFilter != null)
  ) {
    const leaves = collectLeaves(
      progress,
      scope.seasonFilter,
      scope.episodeFilter,
    );
    if (!leaves.length) return null;
    fold = foldLeaves(leaves);
  } else {
    // Unscoped, or a movie's single download: the entry already carries the fold
    // of everything under it. A series with no leaf left is nothing in flight.
    if (progress.seasons && !collectLeaves(progress).length) return null;
    fold = { state: progress.state, percent: progress.percent };
  }

  return {
    labelKey: qbStateLabelKey(fold.state),
    badgeClass: qbStateBadgeClass(fold.state),
    percent: fold.percent,
    isClickable: true,
    busy: fold.state === 'searching',
  };
}
