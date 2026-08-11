import {
  qbStateVariant,
  qbStateLabelKey,
  qbStateBadgeClass,
  dominantState,
  activeWeightedPercent,
  foldLeaves,
  describeBadge,
} from './download-format';
import { DownloadLeaf, MediaDownloadProgress } from '../../core/services/download-progress.service';
import { DownloadProgressState } from '../../core/enums/download-progress-state.enum';

const leaf = (state: DownloadProgressState, percent = 50, weight?: number): DownloadLeaf => ({
  state,
  percent,
  weight,
});

describe('download-format', () => {
  describe('qbStateVariant / qbStateLabelKey / qbStateBadgeClass', () => {
    it('maps every closed state to a colour + label + badge class', () => {
      expect(qbStateVariant('queued')).toBe('warning');
      expect(qbStateVariant('active')).toBe('primary');
      expect(qbStateVariant('stalled')).toBe('warning');
      expect(qbStateVariant('paused')).toBe('neutral');
      expect(qbStateVariant('importing')).toBe('success');

      expect(qbStateLabelKey('queued')).toBe('activity.tstatus_queued');
      expect(qbStateLabelKey('active')).toBe('activity.tstatus_downloading');
      expect(qbStateLabelKey('stalled')).toBe('activity.tstatus_stalled');
      expect(qbStateLabelKey('paused')).toBe('activity.tstatus_paused');
      expect(qbStateLabelKey('importing')).toBe('activity.fstatus_importing');

      expect(qbStateBadgeClass('active')).toBe('badge-info');
      expect(qbStateBadgeClass('stalled')).toBe('badge-warning');
      expect(qbStateBadgeClass('paused')).toBe('badge-ghost');
      expect(qbStateBadgeClass('importing')).toBe('badge-success');
    });

    it('falls back to primary/unknown for the empty (no leaf) sentinel', () => {
      expect(qbStateVariant('')).toBe('primary');
      expect(qbStateLabelKey('')).toBe('activity.tstatus_unknown');
      expect(qbStateBadgeClass('')).toBe('badge-info');
    });
  });

  describe('dominantState', () => {
    it('returns the empty sentinel for no leaves', () => {
      expect(dominantState([])).toBe('');
    });

    it('ranks stalled above active above queued above importing above paused', () => {
      expect(dominantState(['active', 'stalled'])).toBe('stalled');
      expect(dominantState(['queued', 'active'])).toBe('active');
      expect(dominantState(['paused', 'importing', 'queued'])).toBe('queued');
      expect(dominantState(['paused', 'importing'])).toBe('importing');
    });
  });

  describe('activeWeightedPercent', () => {
    it('excludes leaves already at 100% and returns null when none remain', () => {
      expect(activeWeightedPercent([leaf('active', 100)])).toBeNull();
      expect(activeWeightedPercent([])).toBeNull();
    });

    it('averages plainly when leaves carry no weight', () => {
      expect(activeWeightedPercent([leaf('active', 40), leaf('active', 60)])).toBe(50);
    });

    it('weights by size when every active leaf carries one', () => {
      const percent = activeWeightedPercent([
        leaf('active', 10, 900),
        leaf('active', 90, 100),
      ]);
      // (10*900 + 90*100) / 1000 = 18
      expect(percent).toBe(18);
    });
  });

  describe('foldLeaves', () => {
    it('folds dominant state, weighted percent and stalled count', () => {
      const fold = foldLeaves([leaf('stalled', 50), leaf('active', 30), leaf('stalled', 10)]);
      expect(fold.state).toBe('stalled');
      expect(fold.total).toBe(3);
      expect(fold.stalled).toBe(2);
    });
  });

  describe('describeBadge', () => {
    it('falls back to the monitored badge when there is no progress', () => {
      const d = describeBadge(null, { monitored: true, downloaded: false });
      expect(d.labelKey).toBe('requests.badge_monitored');
      expect(d.isClickable).toBe(false);
    });

    it('hides the badge once downloaded, even unmonitored', () => {
      const d = describeBadge(null, { monitored: false, downloaded: true });
      expect(d.labelKey).toBeNull();
    });

    it('describes a movie in flight with its own state/percent', () => {
      const progress: MediaDownloadProgress = {
        mediaId: 1,
        mediaType: 'movie',
        percent: 42,
        state: 'stalled',
        dlspeed: 0,
        eta: 0,
      };
      const d = describeBadge(progress, { monitored: true, downloaded: false });
      expect(d.state).toBe('stalled');
      expect(d.labelKey).toBe('activity.tstatus_stalled');
      expect(d.badgeClass).toBe('badge-warning');
      expect(d.percent).toBe(42);
      expect(d.isClickable).toBe(true);
      expect(d.totalLeaves).toBe(1);
      expect(d.stalledLeaves).toBe(1);
    });

    it('narrows a series to the requested seasons and folds only those leaves', () => {
      const progress: MediaDownloadProgress = {
        mediaId: 2,
        mediaType: 'series',
        percent: 20,
        state: 'active',
        dlspeed: 0,
        eta: 0,
        seasons: new Map([
          [1, { leaves: new Map([[1, leaf('stalled', 10)]]) }],
          [2, { leaves: new Map([[1, leaf('active', 80)]]) }],
        ]),
      };
      const d = describeBadge(progress, {
        monitored: true,
        downloaded: false,
        seasonFilter: [2],
      });
      expect(d.state).toBe('active');
      expect(d.totalLeaves).toBe(1);
      expect(d.stalledLeaves).toBe(0);
    });
  });
});
