import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLoadOptions, parseMuteRanges, parseSubtitleStyle } from './player-parse.ts';

test('load options keep known fields only', () => {
  assert.deepEqual(
    parseLoadOptions({ url: 'http://x/a.m3u8', startTime: 5, headers: { Authorization: 'Bearer t' }, extra: 1 }),
    {
      url: 'http://x/a.m3u8',
      startTime: 5,
      startPaused: undefined,
      headers: { Authorization: 'Bearer t' },
      audioLanguage: undefined,
      videoCrop: undefined,
    },
  );
});

test('load options refuse a wrong type', () => {
  assert.throws(() => parseLoadOptions({ url: 3 }));
  assert.throws(() => parseLoadOptions({ url: 'x', headers: { a: 1 } }));
  assert.throws(() => parseLoadOptions(null));
});

test('mute ranges and subtitle style are rebuilt field by field', () => {
  assert.deepEqual(parseMuteRanges([{ start: 1, end: 2, x: 3 }]), [{ start: 1, end: 2 }]);
  assert.throws(() => parseMuteRanges([{ start: 1 }]));
  assert.throws(() => parseMuteRanges('no'));
  const style = parseSubtitleStyle({ fontScale: 1, foregroundColor: '#fff', backgroundColor: '#000', bottomMarginPercent: 5 });
  assert.equal(style.topMarginPercent, undefined);
  assert.throws(() => parseSubtitleStyle({ fontScale: '1' }));
});
