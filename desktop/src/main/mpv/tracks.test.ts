import assert from 'node:assert/strict';
import test from 'node:test';
import { mapTrackList, parseTracks, type MpvTrack } from './tracks.ts';

const embedded: MpvTrack = {
  id: 1,
  type: 'sub',
  codec: 'subrip',
  lang: 'fre',
  title: 'Full',
  'ff-index': 3,
  selected: false,
};

test('embedded text track keeps its container stream index', () => {
  const [sub] = mapTrackList([embedded]).subtitleTracks;
  assert.equal(sub.ffIndex, 3);
  assert.equal(sub.external, false);
  assert.equal(sub.source, null);
  assert.equal(sub.image, false);
});

test('sidecar exposes the URL it was added from and no stream index', () => {
  const url = 'https://srv/api/subtitles/12/download?token=t';
  // mpv reports ff-index 0 for every sidecar; it is not a container stream.
  const [sub] = mapTrackList([
    { id: 4, type: 'sub', codec: 'subrip', external: true, 'external-filename': url, 'ff-index': 0 },
  ]).subtitleTracks;
  assert.equal(sub.external, true);
  assert.equal(sub.source, url);
  assert.equal(sub.ffIndex, null);
});

test('image subtitle codecs stay in the list, flagged', () => {
  const tracks = mapTrackList([
    { id: 1, type: 'sub', codec: 'hdmv_pgs_subtitle', lang: 'eng', 'ff-index': 5 },
    { id: 2, type: 'sub', codec: 'dvd_subtitle', 'ff-index': 6 },
    embedded,
  ]).subtitleTracks;
  assert.deepEqual(
    tracks.map((t) => [t.id, t.image, t.ffIndex]),
    [
      ['1', true, 5],
      ['2', true, 6],
      ['1', false, 3],
    ],
  );
});

test('audio tracks are unaffected by subtitle identity fields', () => {
  const { audioTracks, subtitleTracks } = mapTrackList([
    { id: 1, type: 'audio', lang: 'fre', title: 'VF', selected: true },
    { id: 2, type: 'video' },
  ]);
  assert.deepEqual(audioTracks, [{ id: '1', language: 'fre', label: 'VF', selected: true }]);
  assert.deepEqual(subtitleTracks, []);
});

test('parseTracks reads the hyphenated keys of the track-list JSON', () => {
  const json = JSON.stringify([
    { id: 1, type: 'sub', codec: 'ass', external: true, 'external-filename': '/tmp/a.ass' },
  ]);
  assert.equal(parseTracks(json).subtitleTracks[0].source, '/tmp/a.ass');
});

test('parseTracks tolerates a missing or malformed list', () => {
  assert.deepEqual(parseTracks(null), { audioTracks: [], subtitleTracks: [] });
  assert.deepEqual(parseTracks('{'), { audioTracks: [], subtitleTracks: [] });
});
