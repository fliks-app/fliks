import {
  qbStateVariant,
  qbStateLabelKey,
  qbStateBadgeClass,
  dominantState,
  activeWeightedPercent,
  foldLeaves,
  describeBadge,
  describeDownload,
} from './download-format';
import { DownloadLeaf, MediaDownloadProgress } from '../../core/services/download-progress.service';
import { DownloadProgressState } from '../../core/enums/download-progress-state.enum';

const leaf = (state: DownloadProgressState, percent = 50): DownloadLeaf => ({ state, percent });

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

    it('averages across the active leaves', () => {
      expect(activeWeightedPercent([leaf('active', 40), leaf('active', 60)])).toBe(50);
    });
  });

  describe('foldLeaves', () => {
    it('folds dominant state, weighted percent and stalled count', () => {
      const fold = foldLeaves([leaf('stalled', 50), leaf('active', 30), leaf('stalled', 10)]);
      expect(fold.state).toBe('stalled');
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
      expect(d.labelKey).toBe('activity.tstatus_stalled');
      expect(d.badgeClass).toBe('badge-warning');
      expect(d.percent).toBe(42);
      expect(d.isClickable).toBe(true);
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
    });
  });

  /**
   * What the episode header renders. An episode page must answer "is THIS
   * episode downloading" — a sibling's grab belongs on the sibling's page, and
   * a season pack legitimately belongs on every episode page of that season.
   */
  describe('describeDownload — episode scope', () => {
    // The store keys a leaf by its torrent and records the episode on the leaf,
    // so a fixture has to carry the attribute the scope filter reads.
    const season1 = (leaves: [number | 'PACK', DownloadLeaf][]): MediaDownloadProgress => ({
      mediaId: 2,
      mediaType: 'series',
      percent: 50,
      state: 'active',
      dlspeed: 0,
      eta: 0,
      seasons: new Map([
        [
          1,
          {
            leaves: new Map(
              leaves.map(([k, l]) => [k, typeof k === 'number' ? { ...l, episodeNumber: k } : l]),
            ),
          },
        ],
      ]),
    });

    it('says nothing on episode 7 while only episode 8 downloads', () => {
      const d = describeDownload(season1([[8, leaf('active', 52)]]), {
        seasonFilter: [1],
        episodeFilter: 7,
      });
      expect(d).toBeNull();
    });

    it("reports the episode's own torrent", () => {
      const d = describeDownload(season1([[7, leaf('active', 52)]]), {
        seasonFilter: [1],
        episodeFilter: 7,
      });
      expect(d?.percent).toBe(52);
    });

    it('reports a season pack on every episode of the season', () => {
      const progress = season1([['PACK', leaf('active', 30)]]);
      expect(describeDownload(progress, { seasonFilter: [1], episodeFilter: 7 })?.percent).toBe(30);
      expect(describeDownload(progress, { seasonFilter: [1], episodeFilter: 8 })?.percent).toBe(30);
    });

    // Real season-pack ticks arrive with a torrent ref and no episode number,
    // so the store keys them `hash:<ref>` — never the literal 'PACK' sentinel.
    it('reports a hash-keyed pack on an episode page', () => {
      const progress: MediaDownloadProgress = {
        mediaId: 2,
        mediaType: 'series',
        percent: 30,
        state: 'active',
        dlspeed: 0,
        eta: 0,
        seasons: new Map([[1, { leaves: new Map([['hash:abc', leaf('active', 30)]]) }]]),
      };
      expect(describeDownload(progress, { seasonFilter: [1], episodeFilter: 7 })?.percent).toBe(30);
    });

    it('is null with no progress at all, rather than a monitored chip', () => {
      expect(describeDownload(null)).toBeNull();
      expect(describeBadge(null, { monitored: true, downloaded: false }).labelKey).toBe(
        'requests.badge_monitored',
      );
    });
  });
});
