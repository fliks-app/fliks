import assert from 'node:assert/strict';
import test from 'node:test';
import { FirstFrameGate } from './first-frame-gate.ts';

const settled = async (p: Promise<void>): Promise<boolean> =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setImmediate(() => r(false)))]);

test('wait stays pending until the first frame releases it', async () => {
  const gate = new FirstFrameGate();
  const wait = gate.wait(60_000);
  assert.equal(await settled(wait), false);
  gate.release();
  assert.equal(await settled(wait), true);
});

test('a newer wait releases the superseded one', async () => {
  const gate = new FirstFrameGate();
  const first = gate.wait(60_000);
  const second = gate.wait(60_000);
  assert.equal(await settled(first), true);
  assert.equal(await settled(second), false);
  gate.release();
});

test('a file that never opens does not hang the caller', async () => {
  await new FirstFrameGate().wait(5);
});

test('release with nothing pending is a no-op', () => {
  new FirstFrameGate().release();
});
