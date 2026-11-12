import { describe, expect, it } from 'vitest';
import type { ArtistAlbum, Track } from '../../core/services/api/music.models';
import { artistLine, formatDuration, groupByWork, discographyTab, discographyTabs, groupDiscs, toTrackRequest } from './music-utils';

const track = (o: Partial<Track>): Track => ({
  itemId: 1, editionId: 1, mediaFileId: 1, hasFile: true, orphaned: false, discNumber: 1, discTitle: null, position: 1,
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
