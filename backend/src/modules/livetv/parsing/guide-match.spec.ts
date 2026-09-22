import { matchGuideChannels, pickHighestPriorityRows } from './guide-match';

const candidates = [
  { id: 'one.fr', displayNames: ['One'] },
  { id: 'sport.fr', displayNames: ['Sport One', 'Sport 1'] },
  { id: 'news.fr', displayNames: ['World News Channel'] },
];

describe('matchGuideChannels', () => {
  it('matches on the guide id first', () => {
    const report = matchGuideChannels(
      [{ id: 1, name: 'Whatever', guideChannelId: 'ONE.FR', guideMatchKind: null }],
      candidates,
    );
    expect(report.assignments).toEqual([
      { channelId: 1, guideChannelId: 'one.fr', kind: 'id' },
    ]);
  });

  it('falls back to the normalised name', () => {
    const report = matchGuideChannels(
      [{ id: 2, name: 'FR: Sport One FHD', guideChannelId: null, guideMatchKind: null }],
      candidates,
    );
    expect(report.assignments).toEqual([
      { channelId: 2, guideChannelId: 'sport.fr', kind: 'name' },
    ]);
  });

  it('accepts a close token overlap and reports it as fuzzy', () => {
    const report = matchGuideChannels(
      [{ id: 3, name: 'World News Channel Europe', guideChannelId: null, guideMatchKind: null }],
      candidates,
    );
    expect(report.assignments[0]).toMatchObject({ channelId: 3, kind: 'fuzzy' });
  });

  it('leaves a channel unmatched rather than guessing', () => {
    const report = matchGuideChannels(
      [{ id: 4, name: 'Cooking Plus', guideChannelId: null, guideMatchKind: null }],
      candidates,
    );
    expect(report.assignments).toEqual([]);
    expect(report.unmatchedChannelIds).toEqual([4]);
  });

  it('still finds the right fuzzy match among many unrelated candidates', () => {
    // The indexed fuzzy pass only scores candidates sharing a token with the
    // channel; this proves it still reaches the correct one, not just a fast one.
    const manyCandidates = [
      ...candidates,
      ...Array.from({ length: 500 }, (_, i) => ({
        id: `filler${i}.fr`,
        displayNames: [`Filler Channel ${i}`, `Unrelated Show ${i}`],
      })),
    ];
    const report = matchGuideChannels(
      [{ id: 6, name: 'World News Channel Europe', guideChannelId: null, guideMatchKind: null }],
      manyCandidates,
    );
    expect(report.assignments).toEqual([
      { channelId: 6, guideChannelId: 'news.fr', kind: 'fuzzy' },
    ]);
  });

  it('never revisits a manual assignment', () => {
    const report = matchGuideChannels(
      [{ id: 5, name: 'One', guideChannelId: 'sport.fr', guideMatchKind: 'manual' }],
      candidates,
    );
    expect(report.assignments).toEqual([]);
    expect(report.unmatchedChannelIds).toEqual([]);
  });

  it('counts each pass for the admin report', () => {
    const report = matchGuideChannels(
      [
        { id: 1, name: 'x', guideChannelId: 'one.fr', guideMatchKind: null },
        { id: 2, name: 'Sport One', guideChannelId: null, guideMatchKind: null },
        { id: 4, name: 'Cooking Plus', guideChannelId: null, guideMatchKind: null },
      ],
      candidates,
    );
    expect(report.byKind).toEqual({ id: 1, name: 1, fuzzy: 0 });
    expect(report.unmatchedChannelIds).toEqual([4]);
  });
});

describe('pickHighestPriorityRows', () => {
  it('keeps only the higher-priority source when two feeds share a channel id', () => {
    const rows = [
      { guideChannelId: 'x', guideSourceId: 1, title: 'from A' },
      { guideChannelId: 'x', guideSourceId: 2, title: 'from B' },
      { guideChannelId: 'y', guideSourceId: 2, title: 'only B' },
    ];
    const result = pickHighestPriorityRows(
      rows,
      new Map([
        [1, 0],
        [2, 5],
      ]),
    );
    expect(result).toEqual([
      { guideChannelId: 'x', guideSourceId: 2, title: 'from B' },
      { guideChannelId: 'y', guideSourceId: 2, title: 'only B' },
    ]);
  });

  it('treats a source missing from the priority map as priority 0', () => {
    const rows = [
      { guideChannelId: 'x', guideSourceId: 1, title: 'known' },
      { guideChannelId: 'x', guideSourceId: 2, title: 'unknown source' },
    ];
    const result = pickHighestPriorityRows(rows, new Map([[1, 1]]));
    expect(result).toEqual([{ guideChannelId: 'x', guideSourceId: 1, title: 'known' }]);
  });

  it('breaks a priority tie deterministically by the lower source id', () => {
    const rows = [
      { guideChannelId: 'x', guideSourceId: 5, title: 'five' },
      { guideChannelId: 'x', guideSourceId: 2, title: 'two' },
    ];
    const result = pickHighestPriorityRows(rows, new Map());
    expect(result).toEqual([{ guideChannelId: 'x', guideSourceId: 2, title: 'two' }]);
  });

  it('leaves unrelated channel ids untouched', () => {
    const rows = [
      { guideChannelId: 'a', guideSourceId: 1, title: 'a' },
      { guideChannelId: 'b', guideSourceId: 2, title: 'b' },
    ];
    expect(pickHighestPriorityRows(rows, new Map())).toEqual(rows);
  });
});
