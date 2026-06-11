/** Shared download-progress formatting + qBittorrent state mapping, used by the
 *  Activity queue, the request rows, and media-detail so the numbers and the
 *  progress-bar colour are rendered identically everywhere. */

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

/** Map a raw qBittorrent torrent state to a progress-bar colour variant. */
export function qbStateVariant(state: string): ProgressVariant {
  switch (state) {
    case 'downloading':
    case 'forcedDL':
    case 'metaDL':
    case 'forcedMetaDL':
    case 'allocating':
      return 'primary';
    case 'uploading':
    case 'stalledUP':
    case 'forcedUP':
    case 'queuedUP':
    case 'checkingUP':
      return 'success';
    case 'stalledDL':
    case 'queuedDL':
    case 'checkingDL':
    case 'checkingResumeData':
    case 'moving':
      return 'warning';
    case 'error':
    case 'missingFiles':
      return 'error';
    case 'pausedDL':
    case 'pausedUP':
    case 'stoppedDL':
    case 'stoppedUP':
      return 'neutral';
    default:
      return 'primary';
  }
}

/**
 * Raw qB state → existing `activity.tstatus_*` i18n key. Keyed off the RAW
 * state (the badge store carries raw states), unlike the Activity queue which
 * slugs the backend-humanized `trackerStatus`. Both resolve to the same key set
 * so the wording stays consistent; unmapped states fall back to `unknown`.
 */
export function qbStateLabelKey(state: string): string {
  switch (state) {
    case 'downloading':
    case 'forcedDL':
      return 'activity.tstatus_downloading';
    case 'metaDL':
    case 'forcedMetaDL':
      return 'activity.tstatus_downloading_metadata';
    case 'allocating':
      return 'activity.tstatus_allocating';
    case 'stalledDL':
      return 'activity.tstatus_stalled';
    case 'queuedDL':
      return 'activity.tstatus_queued';
    case 'checkingDL':
    case 'checkingResumeData':
      return 'activity.tstatus_checking';
    case 'moving':
      return 'activity.tstatus_moving';
    case 'pausedDL':
    case 'pausedUP':
      return 'activity.tstatus_paused';
    case 'stoppedDL':
    case 'stoppedUP':
      return 'activity.tstatus_stopped';
    case 'missingFiles':
      return 'activity.tstatus_missing_files';
    case 'error':
      return 'activity.tstatus_error';
    case 'seeding':
    case 'uploading':
    case 'forcedUP':
    case 'stalledUP':
    case 'queuedUP':
    case 'checkingUP':
      return 'activity.tstatus_seeding';
    default:
      return 'activity.tstatus_unknown';
  }
}

const VARIANT_BADGE_CLASS: Record<ProgressVariant, string> = {
  primary: 'badge-info',
  success: 'badge-success',
  warning: 'badge-warning',
  error: 'badge-error',
  neutral: 'badge-ghost',
};

/** Raw qB state → daisyUI badge colour class (via {@link qbStateVariant}). */
export function qbStateBadgeClass(state: string): string {
  return VARIANT_BADGE_CLASS[qbStateVariant(state)];
}

// Precedence for folding several concurrent torrents into one status: failures
// first, then the most-active state wins (downloading outranks stalled/queued).
// The per-leaf breakdown lives in the detail modal.
const STATE_RANK: Record<string, number> = {
  error: 1,
  missingFiles: 1,
  downloading: 2,
  forcedDL: 2,
  metaDL: 3,
  forcedMetaDL: 3,
  allocating: 4,
  stalledDL: 5,
  queuedDL: 6,
  checkingDL: 7,
  checkingResumeData: 7,
  moving: 8,
  pausedDL: 9,
  pausedUP: 9,
  stoppedDL: 10,
  stoppedUP: 10,
  seeding: 11,
  uploading: 11,
  forcedUP: 11,
  stalledUP: 11,
  queuedUP: 11,
  checkingUP: 11,
};

/** Representative raw state for a set of concurrent torrents (see STATE_RANK).
 *  Returns '' for an empty set (no in-flight leaf). */
export function dominantState(states: string[]): string {
  let best = '';
  let bestRank = Infinity;
  for (const s of states) {
    const r = STATE_RANK[s] ?? 99;
    if (r < bestRank) {
      bestRank = r;
      best = s;
    }
  }
  return best;
}

const COMPLETING_STATES = new Set([
  'seeding',
  'uploading',
  'forcedUP',
  'stalledUP',
  'queuedUP',
  'checkingUP',
]);

/** Size-weighted mean percent over the still-downloading leaves only — a leaf
 *  that's seeding/completing or already at 100% is excluded, so a finishing
 *  pack never shows a misleading "downloading 96%". Weighted by torrent size
 *  when every active leaf carries one (seeded from the queue), else a plain
 *  leaf-count mean. Null when nothing is actively downloading. */
export function activeWeightedPercent(leaves: DownloadLeaf[]): number | null {
  const active = leaves.filter(
    (l) => !COMPLETING_STATES.has(l.state) && l.percent < 100,
  );
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
  state: string;
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
    stalled: leaves.filter((l) => l.state === 'stalledDL').length,
  };
}

export interface DownloadBadgeDescriptor {
  /** Representative raw qB state; '' when no download is in flight. */
  state: string;
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
  const base = { state: '', percent: null, isClickable: false, totalLeaves: 0, stalledLeaves: 0 };
  if (downloaded) return { ...base, labelKey: null, badgeClass: '' };
  return monitored
    ? { ...base, labelKey: 'requests.badge_monitored', badgeClass: 'badge-info' }
    : { ...base, labelKey: 'requests.badge_unmonitored', badgeClass: 'badge-ghost' };
}

function collectLeaves(
  progress: MediaDownloadProgress,
  seasonFilter?: number[],
): DownloadLeaf[] {
  if (!progress.seasons) return [];
  const out: DownloadLeaf[] = [];
  for (const [seasonNumber, sp] of progress.seasons) {
    if (seasonFilter?.length && !seasonFilter.includes(seasonNumber)) continue;
    for (const leaf of sp.leaves.values()) out.push(leaf);
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
  opts: { monitored: boolean; downloaded: boolean; seasonFilter?: number[] },
): DownloadBadgeDescriptor {
  if (!progress) return fallbackDescriptor(opts.monitored, opts.downloaded);

  let fold: LeafFold;
  if (progress.seasons && opts.seasonFilter?.length) {
    const leaves = collectLeaves(progress, opts.seasonFilter);
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
      stalled: leaves.filter((l) => l.state === 'stalledDL').length,
    };
  } else {
    // Movie: a single torrent; state/percent already folded onto the entry.
    fold = {
      state: progress.state,
      percent: progress.percent,
      total: 1,
      stalled: progress.state === 'stalledDL' ? 1 : 0,
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
