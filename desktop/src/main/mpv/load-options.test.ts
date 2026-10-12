import assert from 'node:assert/strict';
import test from 'node:test';
import { mpvLoadFileOptions, mpvLoadRequest } from './load-options.ts';

test('every load switches the subtitle off so mpv never auto-picks one', () => {
  assert.deepEqual(mpvLoadFileOptions({ url: 'u' }), ['sid=no']);
});

test('start time and audio language ride along as file-local options', () => {
  assert.deepEqual(
    mpvLoadFileOptions({ url: 'u', startTime: 12.34567, audioLanguage: 'fre' }),
    ['sid=no', 'start=+12.346', 'alang=fre'],
  );
});

test('a zero start time and an empty language add nothing', () => {
  assert.deepEqual(mpvLoadFileOptions({ url: 'u', startTime: 0, audioLanguage: '' }), ['sid=no']);
});

test('the addon request keeps the renderer options next to the file options', () => {
  assert.deepEqual(mpvLoadRequest({ url: 'u', videoCrop: '1x1+0+0' }), {
    url: 'u',
    videoCrop: '1x1+0+0',
    fileOptions: ['sid=no'],
  });
});
