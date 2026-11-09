import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMpvLists } from './mpv-lists.ts';

test('parses the JSON text libmpv returns', () => {
  const lists = parseMpvLists(
    '[{"codec":"h264","driver":"h264","description":"H.264"},{"codec":"h264","driver":"h264_cuvid","description":"x"},{"codec":"eac3","driver":"eac3","description":"E-AC-3"}]',
    'aa,matroska,webm,mov',
  );
  assert.deepEqual(lists.decoders, ['h264', 'eac3']);
  assert.deepEqual(lists.demuxers, ['aa', 'matroska', 'webm', 'mov']);
});

test('takes the parsed values mpv IPC returns', () => {
  const lists = parseMpvLists([{ codec: 'hevc' }], ['mov,mp4', 'avi']);
  assert.deepEqual(lists, { decoders: ['hevc'], demuxers: ['mov', 'mp4', 'avi'] });
});

test('is empty for a missing answer', () => {
  assert.deepEqual(parseMpvLists(undefined, undefined), { decoders: [], demuxers: [] });
});
