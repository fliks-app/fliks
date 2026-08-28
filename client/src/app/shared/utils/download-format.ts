/** Shared download-progress formatting + state mapping, used by the Activity
 *  queue, the request rows, and media-detail so the numbers and the
 *  progress-bar colour are rendered identically everywhere. */

import type { DownloadProgressState } from '../../core/enums/download-progress-state.enum';
import type {
  DownloadLeaf,
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
  // qBittorrent reports 8640000s (100 days) as its "infinite" ETA sentinel for
  // stalled / no-progress torrents — show ∞ rather than a bogus "2400h 0m".
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
const VARIANT_BY_STATE: Record<DownloadProgressState, ProgressVariant> = {
  queued: 'warning',
  active: 'primary',
  stalled: 'warning',
  paused: 'neutral',
  importing: 'success',
};

/** Colour variant for a state; '' (no in-flight leaf) reads as `primary`. */
export function qbStateVariant(state: DownloadProgressState | ''): ProgressVariant {
  return state ? VARIANT_BY_STATE[state] : 'primary';
}

/** Closed-state → `activity.*` i18n key (reuses the existing torrent/import
 *  status keys so no new translations are needed). */
const LABEL_KEY_BY_STATE: Record<DownloadProgressState, string> = {
  queued: 'activity.tstatus_queued',
  active: 'activity.tstatus_downloading',
  stalled: 'activity.tstatus_stalled',
  paused: 'activity.tstatus_paused',
  importing: 'activity.fstatus_importing',
};

export function qbStateLabelKey(state: DownloadProgressState | ''): string {
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
export function qbStateBadgeClass(state: DownloadProgressState | ''): string {
  return VARIANT_BADGE_CLASS[qbStateVariant(state)];
}

// Precedence for folding several concurrent leaves into one status, most
// prominent first. `stalled` absorbs what used to be the vendor's dedicated
// error states, so it still outranks `active` the way a real failure did;
// otherwise the most-active state wins. The per-leaf breakdown lives in the
// detail modal.
const STATE_RANK: Record<DownloadProgressState, number> = {
  stalled: 1,
  active: 2,
  queued: 3,
  importing: 4,
  paused: 5,
};

/** Representative state for a set of concurrent leaves (see STATE_RANK).
 *  Returns '' for an empty set (no in-flight leaf). */
export function dominantState(
  states: DownloadProgressState[],
): DownloadProgressState | '' {
  let best: DownloadProgressState | '' = '';
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

/** Size-weighted mean percent over the still-downloading leaves only — a leaf
 *  already at 100% is excluded (rounding can land a near-complete leaf there
 *  just before the store retires it), so a finishing pack never shows a
 *  misleading "downloading 96%". Weighted by torrent size when every active
 *  leaf carries one (seeded from the queue), else a plain leaf-count mean.
 *  Null when nothing is actively downloading. */
export function activeWeightedPercent(leaves: DownloadLeaf[]): number | null {
  const active = leaves.filter((l) => l.percent < 100);
  if (!active.length) return null;
  if (active.every((l) => l.weight != null && l.weight > 0)) {
    const total = active.reduce((a, l) => a + (l.weight as number), 0);
    const sum = active.reduce(
      (a, l) => a + l.percent * (l.weight as number),
      0,
    );
    return Math.round(sum / total);
  }
  return Math.round(active.reduce((a, l) => a + l.percent, 0) / active.length);
}

export interface LeafFold {
  state: DownloadProgressState | '';
  percent: number | null;
  total: number;
  stalled: number;
}

/** Fold a set of leaves into one status — dominant state + active percent +
 *  counts. The single aggregation primitive reused by the progress store, the
 *  badge descriptor and the detail modal. */
export function foldLeaves(leaves: DownloadLeaf[]): LeafFold {
  return {
    state: dominantState(leaves.map((l) => l.state)),
    percent: activeWeightedPercent(leaves),
    total: leaves.length,
    stalled: leaves.filter((l) => l.state === 'stalled').length,
  };
}

export interface DownloadBadgeDescriptor {
  /** Representative state; '' when no download is in flight. */
  state: DownloadProgressState | '';
  /** ngx-translate key for the badge, or null to render nothing. */
  labelKey: string | null;
  badgeClass: string;
  percent: number | null;
  /** True iff there is ≥1 in-flight leaf in scope (so the modal has content). */
  isClickable: boolean;
  totalLeaves: number;
  stalledLeaves: number;
}

function fallbackDescriptor(
  monitored: boolean,
  downloaded: boolean,
): DownloadBadgeDescriptor {
  const base = { state: '' as const, percent: null, isClickable: false, totalLeaves: 0, stalledLeaves: 0 };
  if (downloaded) return { ...base, labelKey: null, badgeClass: '' };
  return monitored
    ? { ...base, labelKey: 'requests.badge_monitored', badgeClass: 'badge-info' }
    : { ...base, labelKey: 'requests.badge_unmonitored', badgeClass: 'badge-ghost' };
}

function collectLeaves(
  progress: MediaDownloadProgress,
  seasonFilter?: number[],
  episodeFilter?: number,
): DownloadLeaf[] {
  if (!progress.seasons) return [];
  const out: DownloadLeaf[] = [];
  for (const [seasonNumber, sp] of progress.seasons) {
    if (seasonFilter?.length && !seasonFilter.includes(seasonNumber)) continue;
    for (const [key, leaf] of sp.leaves) {
      // A season pack carries the episode too, so it counts in an episode scope.
      if (episodeFilter != null && key !== episodeFilter && key !== 'PACK') {
        continue;
      }
      out.push(leaf);
    }
  }
  return out;
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
    /** Narrow to one episode — its own torrent, or a pack that contains it. */
    episodeFilter?: number;
  },
): DownloadBadgeDescriptor {
  if (!progress) return fallbackDescriptor(opts.monitored, opts.downloaded);

  let fold: LeafFold;
  if (
    progress.seasons &&
    (opts.seasonFilter?.length || opts.episodeFilter != null)
  ) {
    const leaves = collectLeaves(
      progress,
      opts.seasonFilter,
      opts.episodeFilter,
    );
    if (!leaves.length) {
      return fallbackDescriptor(opts.monitored, opts.downloaded);
    }
    fold = foldLeaves(leaves);
  } else if (progress.seasons) {
    const leaves = collectLeaves(progress);
    if (!leaves.length) {
      return fallbackDescriptor(opts.monitored, opts.downloaded);
    }
    fold = {
      state: progress.state,
      percent: progress.percent,
      total: leaves.length,
      stalled: leaves.filter((l) => l.state === 'stalled').length,
    };
  } else {
    // Movie: a single torrent; state/percent already folded onto the entry.
    fold = {
      state: progress.state,
      percent: progress.percent,
      total: 1,
      stalled: progress.state === 'stalled' ? 1 : 0,
    };
  }

  return {
    state: fold.state,
    labelKey: qbStateLabelKey(fold.state),
    badgeClass: qbStateBadgeClass(fold.state),
    percent: fold.percent,
    isClickable: true,
    totalLeaves: fold.total,
    stalledLeaves: fold.stalled,
  };
}
