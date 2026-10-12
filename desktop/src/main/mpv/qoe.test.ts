import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readQoe } from './qoe.ts';

test('maps mpv properties and treats unavailable as null', async () => {
  const props: Record<string, string | number> = {
    'frame-drop-count': '3',
    'decoder-frame-drop-count': 2,
    'estimated-frame-number': '1000',
    'hwdec-current': 'vaapi',
    'video-format': 'hevc',
    'cache-speed': '125000',
    'video-params/w': 3840,
  };
  const q = await readQoe((n) => {
    if (n in props) return props[n];
    throw new Error('property unavailable');
  });
  assert.equal(q.droppedFrames, 5);
  assert.equal(q.decodedFrames, 1000);
  assert.equal(q.bandwidthBps, 1_000_000);
  assert.equal(q.hwDecoder, true);
  assert.equal(q.decoderName, 'vaapi');
  assert.equal(q.videoCodec, 'hevc');
  assert.equal(q.width, 3840);
  assert.equal(q.height, null);
  assert.equal(q.bufferAheadS, null);
});

test('software decode falls back to the codec name; nothing readable is all null', async () => {
  const sw: Record<string, string> = { 'hwdec-current': 'no', 'video-codec': 'h264' };
  const q = await readQoe((n) => sw[n] ?? null);
  assert.equal(q.hwDecoder, false);
  assert.equal(q.decoderName, 'h264');
  assert.equal(q.droppedFrames, null);
  assert.equal((await readQoe(() => null)).hwDecoder, null);
});
