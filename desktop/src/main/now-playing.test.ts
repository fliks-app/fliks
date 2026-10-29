import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NowPlaying, mediaSessionSetter } from './now-playing.ts';

function setup() {
  const calls: any[] = [];
  let t = 0;
  const np = new NowPlaying(
    { setNowPlaying: (i) => calls.push(i), clearNowPlaying: () => calls.push('clear') },
    () => t,
  );
  return { np, calls, tick: (ms: number) => (t += ms) };
}

test('publishes on state change, then only when the position leaves the extrapolation', () => {
  const { np, calls, tick } = setup();
  const art = Buffer.from('x');
  np.setMetadata({ title: 'T' }, art);
  np.setPosition({ position: 0, duration: 100, buffered: 0 });
  assert.equal(calls.length, 0);
  np.setState('playing');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].artwork, art);
  tick(1000);
  np.setPosition({ position: 1, duration: 100, buffered: 0 });
  assert.equal(calls.length, 1);
  np.setPosition({ position: 40, duration: 100, buffered: 0 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].elapsed, 40);
  assert.equal(calls[1].artwork, undefined);
});

test('clears when playback stops and republishes artwork afterwards', () => {
  const { np, calls } = setup();
  const art = Buffer.from('x');
  np.setMetadata({ title: 'T' }, art);
  np.setState('playing');
  np.setState('idle');
  assert.equal(calls[1], 'clear');
  np.setState('playing');
  assert.equal(calls[2].artwork, art);
  np.setMetadata(null);
  assert.equal(calls[3], 'clear');
});

test('republishes on a rate change and extrapolates drift at that rate', () => {
  const { np, calls, tick } = setup();
  np.setMetadata({ title: 'T' });
  np.setState('playing');
  np.setRate(2);
  assert.equal(calls[1].rate, 2);
  np.setRate(2);
  assert.equal(calls.length, 2);
  tick(10_000);
  np.setPosition({ position: 20, duration: 100, buffered: 0 });
  assert.equal(calls.length, 2);
});

test('a withdrawal or newer metadata drops an artwork fetch still in flight', async () => {
  const { np, calls } = setup();
  const pending: Array<(b: Buffer) => void> = [];
  const set = mediaSessionSetter(np, () => new Promise((r) => pending.push(r)));
  np.setState('playing');
  const first = set({ title: 'A', artworkUrl: 'u' });
  const stop = set(null);
  pending[0]!(Buffer.from('a'));
  await first;
  await stop;
  assert.deepEqual(calls, ['clear']);
  calls.length = 0;
  np.setState('playing');
  const b = set({ title: 'B', artworkUrl: 'u' });
  const c = set({ title: 'C', artworkUrl: 'u' });
  pending[2]!(Buffer.from('c'));
  pending[1]!(Buffer.from('b'));
  await Promise.all([b, c]);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as any).title, 'C');
});
