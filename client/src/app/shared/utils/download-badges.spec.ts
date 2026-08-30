import { collectScopedLeaves } from './download-format';
import { MediaDownloadProgress } from '../../core/services/download-progress.service';

const series = (leaves: [number, [number | 'PACK', { state: 'active'; percent: number }][]][]): MediaDownloadProgress => ({
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
      series([[1, [[6, { state: 'active', percent: 3 }], [8, { state: 'active', percent: 19 }]]]]),
    );

    expect(found.map((f) => [f.seasonNumber, f.key, f.leaf.percent])).toEqual([
      [1, 6, 3],
      [1, 8, 19],
    ]);
  });

  it('spans seasons, so a pack and a loose episode both surface', () => {
    const found = collectScopedLeaves(
      series([
        [1, [[8, { state: 'active', percent: 19 }]]],
        [2, [['PACK', { state: 'active', percent: 40 }]]],
      ]),
    );

    expect(found.map((f) => f.key)).toEqual([8, 'PACK']);
  });

  it('narrows to one episode plus anything that could carry it', () => {
    const found = collectScopedLeaves(
      series([[1, [[6, { state: 'active', percent: 3 }], [8, { state: 'active', percent: 19 }], ['PACK', { state: 'active', percent: 40 }]]]]),
      [1],
      8,
    );

    expect(found.map((f) => f.key)).toEqual([8, 'PACK']);
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
