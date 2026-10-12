import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QoeReader } from './qoe.ts';

type Props = Record<string, string | number>;

function harness() {
  let t = 0;
  let props: Props = {};
  const reader = new QoeReader(() => t);
  return {
    reader,
    read: async (p: Props, advanceMs = 5000) => {
      t += advanceMs;
      props = p;
      return reader.read((n) => {
        if (n in props) return props[n];
        throw new Error('property unavailable');
      });
    },
  };
}

test('maps properties: summed drops, bits per second, hls bitrate over video-bitrate', async () => {
  const { read } = harness();
  const q = await read({
    'frame-drop-count': '3',
    'decoder-frame-drop-count': 2,
    'estimated-frame-number': '1000',
    'hwdec-current': 'vaapi',
    'video-format': 'hevc',
    'cache-speed': '125000',
    'current-tracks/video/hls-bitrate': 6_000_000,
    'video-bitrate': 5_000_000,
    'video-params/w': 3840,
  });
  assert.equal(q?.droppedFrames, 0);
  assert.equal(q?.bandwidthBps, 1_000_000);
  assert.equal(q?.variantBitrate, 6_000_000);
  assert.equal(q?.hwDecoder, true);
  assert.equal(q?.decoderName, 'vaapi');
  assert.equal(q?.videoCodec, 'hevc');
  assert.equal(q?.width, 3840);
  assert.equal(q?.height, null);
});

test('falls back to video-bitrate, maps a full cache (speed 0) to null', async () => {
  const { read } = harness();
  const q = await read({ 'video-bitrate': 4_000_000, 'cache-speed': 0 });
  assert.equal(q?.variantBitrate, 4_000_000);
  assert.equal(q?.bandwidthBps, null);
});

test('decoded frames count decoding only: resume, forward seek and backward seek', async () => {
  const { read } = harness();
  // estimated-vf-fps spikes after a seek; only container-fps (x1.1) bounds a step
  const base = { 'container-fps': 24, 'estimated-vf-fps': 500 };
  const decoded = async (n: number) =>
    Math.round((await read({ ...base, 'estimated-frame-number': n }))?.decodedFrames ?? -1);
  // resume at 3000 s: the first read counts at most the 5 s since load, not the 72k position
  assert.equal(await decoded(72000), 132);
  // 5 s of playback = 120 frames
  assert.equal(await decoded(72120), 252);
  // forward seek of +10 min: the step is capped at 5 s * 24 fps * 1.1
  assert.equal(await decoded(86520), 384);
  // backward seek never goes down; playback resumes from the new position
  assert.equal(await decoded(1000), 384);
  assert.equal(await decoded(1120), 504);
});

test('drop counters survive the resets mpv does on seek, and reset() starts over', async () => {
  const { read, reader } = harness();
  await read({ 'frame-drop-count': 5, 'decoder-frame-drop-count': 1 });
  assert.equal((await read({ 'frame-drop-count': 9, 'decoder-frame-drop-count': 1 }))?.droppedFrames, 4);
  // seek: vo counter back to 0, then 2 new drops
  assert.equal((await read({ 'frame-drop-count': 2, 'decoder-frame-drop-count': 3 }))?.droppedFrames, 8);
  reader.reset();
  assert.equal((await read({ 'frame-drop-count': 7, 'decoder-frame-drop-count': 3 }))?.droppedFrames, 0);
});

test('software decode names the codec; nothing readable gives null', async () => {
  const { read } = harness();
  const q = await read({ 'hwdec-current': 'no', 'video-format': 'h264' });
  assert.equal(q?.hwDecoder, false);
  assert.equal(q?.decoderName, 'h264');
  assert.equal(q?.droppedFrames, null);
  assert.equal(await read({}), null);
});
