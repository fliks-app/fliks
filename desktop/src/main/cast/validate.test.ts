import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLoadOptions, parseTextTrackStyle } from './validate.ts';

const style = {
  fontGenericFamily: 'SANS_SERIF',
  fontScale: 1.2,
  foregroundColor: '#FFFFFFFF',
  backgroundColor: '#00000000',
  edgeType: 'DROP_SHADOW',
  edgeColor: '#000000FF',
  customData: { bottomMargin: 5 },
};
const load = {
  url: 'https://s.example/x.m3u8',
  contentType: 'application/x-mpegurl',
  title: 't',
  subtitle: '',
  posterUrl: '',
  currentTime: 12,
  autoplay: true,
  subtitles: [{ url: 'https://s.example/a.vtt', language: 'fr', label: 'Français' }],
  activeSubtitleTrackId: 1,
};

test('load options are rebuilt, unknown fields dropped at every level', () => {
  const o = parseLoadOptions({
    ...load,
    evil: 1,
    subtitles: [{ ...load.subtitles[0], evil: 1 }],
    customData: { mediaId: 3 },
    castTextTrackStyle: { ...style, evil: 1, customData: { bottomMargin: 5, evil: 1 } },
  });
  assert.deepEqual(o, { ...load, customData: { mediaId: 3 }, castTextTrackStyle: style });
  assert.deepEqual(parseLoadOptions(load), load);
});

test('mistyped load options are refused', () => {
  assert.throws(() => parseLoadOptions({ ...load, currentTime: '12' }));
  assert.throws(() => parseLoadOptions({ ...load, currentTime: NaN }));
  assert.throws(() => parseLoadOptions({ ...load, autoplay: 1 }));
  assert.throws(() => parseLoadOptions({ ...load, subtitles: 'x' }));
  assert.throws(() => parseLoadOptions({ ...load, subtitles: [{ url: 'u' }] }));
  assert.throws(() => parseLoadOptions({ ...load, customData: [] }));
  assert.throws(() => parseLoadOptions(undefined));
});

test('a text track style needs every field', () => {
  assert.deepEqual(parseTextTrackStyle(style), style);
  assert.throws(() => parseTextTrackStyle({ ...style, fontScale: 'big' }));
  assert.throws(() => parseTextTrackStyle({ ...style, customData: undefined }));
});
