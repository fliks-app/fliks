import assert from 'node:assert/strict';
import test from 'node:test';
import { readCapped, saneSize } from './image.ts';

test('a body within the cap is returned', async () => {
  assert.equal((await readCapped(new Response('abc'), 10))?.toString(), 'abc');
});

test('a declared or streamed excess is refused', async () => {
  assert.equal(await readCapped(new Response('abc', { headers: { 'content-length': '999' } }), 10), undefined);
  assert.equal(await readCapped(new Response('x'.repeat(50)), 10), undefined);
  assert.equal(await readCapped(new Response('abc', { status: 404 }), 10), undefined);
});

test('pixel size is bounded', () => {
  assert.equal(saneSize({ width: 300, height: 450 }), true);
  assert.equal(saneSize({ width: 30000, height: 30000 }), false);
  assert.equal(saneSize({ width: 0, height: 0 }), false);
});
