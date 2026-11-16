import { describe, expect, it } from 'vitest';
import type { ArtistAlbum, Track } from '../../core/services/api/music.models';
import { albumSubtitle, artistLine, formatDuration, groupByWork, discographyTab, discographyTabs, groupDiscs, groupReleases, rowStates, splitOrphans, toTrackRequest, versionChip } from './music-utils';

const track = (o: Partial<Track>): Track => ({
  itemId: 1, mediaFileId: 1, hasFile: true, monitored: true, orphaned: false, discNumber: 1, discTitle: null, position: 1,
  trackNumber: 1, label: null, title: 't', durationSeconds: 60, explicit: false, gain: -3, peak: 0.9, artists: [], credits: [],
  works: [], favourite: false, playCount: 0, lastPlayedAt: null, ...o,
});
const album = (o: Partial<ArtistAlbum>): ArtistAlbum => ({
  mediaId: 1, externalId: null, title: 'a', year: 2000, primaryType: 'Album', secondaryTypes: [], posterUrl: null, owned: true,
  monitored: false, trackCount: 1, ownedTrackCount: 1, ...o,
});
const work = (workId: number, position = 0) => ({ workId, title: 'w' + workId, parentWorkId: null, composerPersonId: null, composerName: null, position });

describe('music utils', () => {
  it('formats durations', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('joins artists with their phrases', () => {
    expect(artistLine([{ name: 'A', creditedName: null, joinPhrase: ' & ' }, { name: 'B', creditedName: 'Bee', joinPhrase: null }])).toBe('A & Bee');
    expect(artistLine([{ name: 'A', creditedName: null, joinPhrase: null }, { name: 'B', creditedName: null, joinPhrase: null }])).toBe('A, B');
  });

  it('groups tracks by disc', () => {
    const d = groupDiscs([track({ discNumber: 1 }), track({ discNumber: 1 }), track({ discNumber: 2, discTitle: 'Two' })]);
    expect(d.map((x) => [x.discNumber, x.title, x.tracks.length])).toEqual([[1, null, 2], [2, 'Two', 1]]);
  });

  it('groups consecutive tracks under their work', () => {
    const s = groupByWork([track({ works: [work(1)] }), track({ works: [work(1)] }), track({}), track({ works: [work(2)] })]);
    expect(s.map((x) => [x.work?.workId ?? null, x.tracks.length])).toEqual([[1, 2], [null, 1], [2, 1]]);
  });

  it('builds a queue request, falling back to the album artists', () => {
    const r = toTrackRequest(track({ itemId: 7 }), { mediaId: 3, title: 'Alb', coverUrl: 'c', artists: 'Band', albumGain: -5, albumPeak: 1 });
    expect(r).toMatchObject({ itemId: 7, mediaId: 3, artists: 'Band', albumTitle: 'Alb', gain: -3, albumGain: -5 });
  });

  it('classifies release types into tabs', () => {
    expect(discographyTab(album({}))).toBe('albums');
    expect(discographyTab(album({ secondaryTypes: ['Live'] }))).toBe('other');
    expect(discographyTab(album({ secondaryTypes: ['Compilation', 'Live'] }))).toBe('compilations');
    expect(discographyTab(album({ primaryType: 'EP' }))).toBe('singles');
    expect(discographyTab(album({ primaryType: null }))).toBe('other');
  });

  it('puts owned and missing albums together, newest first', () => {
    const t = discographyTabs([
      album({ title: 'a', year: 1999 }), album({ title: 'b', year: 2005 }), album({ primaryType: 'Single' }),
      album({ owned: false, mediaId: null, title: 'm', year: 2010 }),
    ]);
    expect(t.albums.map((x) => x.title)).toEqual(['m', 'b', 'a']);
    expect(t.singles.length).toBe(1);
    expect(t.compilations).toEqual([]);
  });

  it('puts the albums of popular tracks first, in their order', () => {
    const t = discographyTabs(
      [album({ title: 'new', year: 2020, externalId: 'n' }), album({ title: 'bad', year: 1987, externalId: 'b' }), album({ title: 'thriller', year: 1982, externalId: 't' })],
      [{ albumExternalId: 't' }, { albumExternalId: 'b' }, { albumExternalId: 't' }],
    );
    expect(t.albums.map((x) => x.title)).toEqual(['thriller', 'bad', 'new']);
  });
});

describe('albumSubtitle', () => {
  it('joins the year and the release label', () => {
    expect(albumSubtitle(2005, 'Deluxe')).toBe('2005 · Deluxe');
    expect(albumSubtitle(2005, null)).toBe('2005');
    expect(albumSubtitle(null, null)).toBeUndefined();
  });
});

describe('rowStates', () => {
  const o = (x: Partial<Parameters<typeof rowStates>[1]> = {}) => ({ leaves: [], requested: () => false, admin: true, karaoke: () => null, ...x });
  const kind = (t: Track, x = {}) => rowStates([t], o(x)).get(t.itemId)!;
  const none = { hasFile: false, monitored: false };

  it('is owned with a file, carrying the karaoke prep', () => {
    expect(kind(track({}))).toEqual({ kind: 'owned' });
    expect(kind(track({}), { karaoke: () => ({ state: 'running', progress: 30 }) })).toEqual({ kind: 'owned', karaoke: { progress: 30 } });
  });

  it('is downloading when a leaf covers the track, with the mean percent or none when unknown', () => {
    const leaves = [{ percent: 20, itemIds: [1] }, { percent: 60 }, { percent: 90, itemIds: [2] }];
    expect(kind(track({ ...none }), { leaves })).toEqual({ kind: 'downloading', percent: 40 });
    expect(kind(track({ ...none }), { leaves: [{ percent: null }] })).toEqual({ kind: 'downloading', percent: null });
    expect(kind(track({ ...none, itemId: 3 }), { leaves: [{ percent: 5, itemIds: [1] }] }).kind).toBe('unwanted');
  });

  it('is failed for an admin and wanted for a requester when the last attempt failed', () => {
    const t = track({ hasFile: false, monitored: true, lastAttempt: 'import_failed' });
    expect(kind(t).kind).toBe('failed');
    expect(kind(t, { admin: false }).kind).toBe('wanted');
    expect(kind(track({ hasFile: false, monitored: true, lastAttempt: 'imported' })).kind).toBe('wanted');
  });

  it('is wanted when monitored or requested, else unwanted', () => {
    expect(kind(track({ hasFile: false, monitored: true })).kind).toBe('wanted');
    expect(kind(track({ ...none }), { requested: () => true }).kind).toBe('wanted');
    expect(kind(track({ ...none })).kind).toBe('unwanted');
  });
});

describe('versionChip', () => {
  it('shows the label only when the group has several releases', () => {
    expect(versionChip('Deluxe', 2)).toBe('Deluxe');
    expect(versionChip('Deluxe', 1)).toBeNull();
    expect(versionChip(null, 3)).toBeNull();
  });
});

describe('groupReleases', () => {
  it('folds a release group into its most owned release and counts the versions', () => {
    const out = groupReleases([
      album({ mediaId: 1, releaseGroupId: 'g', ownedTrackCount: 2 }),
      album({ mediaId: 2, releaseGroupId: 'g', ownedTrackCount: 9 }),
      album({ mediaId: 3, releaseGroupId: 'g', ownedTrackCount: 1 }),
      album({ mediaId: null, owned: false, externalId: 'x', ownedTrackCount: 0 }),
    ]);
    expect(out.map((a) => [a.mediaId, a.versions])).toEqual([[2, 3], [null, 1]]);
  });

  it('feeds the tabs one card per group', () => {
    const t = discographyTabs([album({ releaseGroupId: 'g' }), album({ mediaId: 2, releaseGroupId: 'g', ownedTrackCount: 5 })]);
    expect(t.albums).toHaveLength(1);
    expect(t.albums[0]!.versions).toBe(2);
  });
});

describe('splitOrphans', () => {
  it('sets the files with no track of the release apart', () => {
    const r = splitOrphans([track({ itemId: 1 }), track({ itemId: 2, orphaned: true })]);
    expect([r.listed.map((t) => t.itemId), r.orphans.map((t) => t.itemId)]).toEqual([[1], [2]]);
  });
});
