// Run: node --test cast-receiver/mixer.test.js (the decode test needs ffmpeg on PATH)
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BLOCK, mix, flacFrame, initSegment, mediaSegment } = require('./mixer.js');

const sine = (frames, channels, hz, rate) => {
  const pcm = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) pcm[i * channels + c] = Math.round(12000 * Math.sin((2 * Math.PI * hz * (i + c * 7)) / rate));
  return pcm;
};

test('sums the sources at their gains and clips to 16 bits', () => {
  const out = mix([Int16Array.of(1000, 30000, -30000), Int16Array.of(500, 30000, -30000)], [1, 0.5]);
  assert.deepEqual([...out], [1250, 32767, -32768]);
});

test('frames carry the FLAC sync, the sample number and valid CRCs', () => {
  const frame = flacFrame(sine(100, 2, 440, 48000), 2, 48000, 1 << 20);
  assert.deepEqual([...frame.slice(0, 2)], [0xff, 0xf9]);
  assert.equal(frame.length, 4 + 4 + 2 + 1 + 2 * (1 + 200) + 2);
  let crc8 = 0;
  const table8 = (c) => { for (let k = 0; k < 8; k++) c = (c & 0x80 ? (c << 1) ^ 0x07 : c << 1) & 0xff; return c; };
  for (let i = 0; i < 10; i++) crc8 = table8(crc8 ^ frame[i]);
  assert.equal(frame[10], crc8);
});

test('ffmpeg decodes the stream back to the same samples, from a non-zero start', (t) => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { return t.skip('no ffmpeg'); }
  const rate = 48000;
  const channels = 2;
  const start = 3 * BLOCK + 123;
  const pcm = sine(2 * BLOCK + 1000, channels, 330, rate);
  const frames = [];
  const durations = [];
  for (let at = 0; at < pcm.length / channels; at += BLOCK) {
    const chunk = pcm.subarray(at * channels, Math.min(pcm.length, (at + BLOCK) * channels));
    frames.push(flacFrame(chunk, channels, rate, start + at));
    durations.push(chunk.length / channels);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-mixer-'));
  const file = path.join(dir, 'mix.mp4');
  fs.writeFileSync(file, Buffer.concat([initSegment(rate, channels), mediaSegment(1, start, frames.slice(0, 2), durations.slice(0, 2)), mediaSegment(2, start + 2 * BLOCK, frames.slice(2), durations.slice(2))]));
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
  fs.rmSync(dir, { recursive: true });
  const decoded = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  assert.equal(decoded.length, pcm.length);
  assert.deepEqual(decoded, pcm);
});
