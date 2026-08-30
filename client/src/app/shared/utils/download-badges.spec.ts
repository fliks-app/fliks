import { collectScopedLeaves } from './download-format';
import { LeafKey, MediaDownloadProgress } from '../../core/services/download-progress.service';

const series = (
  leaves: [number, [LeafKey, { state: 'active'; percent: number; episodeNumber?: number }][]][],
): MediaDownloadProgress => ({
  mediaId: 1,
  mediaType: 'series',
  percent: 50,
  state: 'active',
  dlspeed: 0,
  eta: 0,
  seasons: new Map(
    leaves.map(([n, l]) => [
      n,
      {
        leaves: new Map(
          l.map(([k, leaf]) => [k, typeof k === 'number' ? { ...leaf, episodeNumber: k } : leaf]),
        ),
      },
    ]),
  ),
});

/**
 * A media can be downloading several things at once — two episodes, or a season
 * pack alongside a straggler. The header used to fold them into one chip, which
 * averaged percentages belonging to different files; each download now gets its
 * own, so the scoped listing has to keep them apart and keep their identity.
 */
describe('collectScopedLeaves — several downloads on one media', () => {
  it('keeps every download, with the season it was found under', () => {
    const found = collectScopedLeaves(
      series([[1, [['ref:e6', { state: 'active', percent: 3, episodeNumber: 6 }], ['ref:e8', { state: 'active', percent: 19, episodeNumber: 8 }]]]]),
    );

    expect(found.map((f) => [f.seasonNumber, f.key, f.leaf.percent])).toEqual([
      [1, 'ref:e6', 3],
      [1, 'ref:e8', 19],
    ]);
  });

  it('spans seasons, so a pack and a loose episode both surface', () => {
    const found = collectScopedLeaves(
      series([
        [1, [['ref:e8', { state: 'active', percent: 19, episodeNumber: 8 }]]],
        [2, [['ref:pack', { state: 'active', percent: 40 }]]],
      ]),
    );

    expect(found.map((f) => f.key)).toEqual(['ref:e8', 'ref:pack']);
  });

  it('narrows to one episode plus anything that could carry it', () => {
    const found = collectScopedLeaves(
      series([[1, [['ref:e6', { state: 'active', percent: 3, episodeNumber: 6 }], ['ref:e8', { state: 'active', percent: 19, episodeNumber: 8 }], ['ref:pack', { state: 'active', percent: 40 }]]]]),
      [1],
      8,
    );

    expect(found.map((f) => f.key)).toEqual(['ref:e8', 'ref:pack']);
  });

  it('is empty for a movie, which has no season dimension to scope by', () => {
    expect(
      collectScopedLeaves({
        mediaId: 1,
        mediaType: 'movie',
        percent: 10,
        state: 'active',
        dlspeed: 0,
        eta: 0,
      }),
    ).toEqual([]);
  });
});
