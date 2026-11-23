import test from 'node:test';
import assert from 'node:assert/strict';
import { str, num, bool, obj, nullable } from './ipc-parse.ts';

test('primitives accept their type and refuse the rest', () => {
  assert.equal(str('a'), 'a');
  assert.throws(() => str(1));
  assert.throws(() => str('x'.repeat(5), 4));
  assert.equal(num(1.5), 1.5);
  assert.throws(() => num(NaN));
  assert.throws(() => num('1'));
  assert.equal(bool(false), false);
  assert.throws(() => bool(0));
  assert.deepEqual(obj({ a: 1 }), { a: 1 });
  assert.throws(() => obj([]));
  assert.throws(() => obj(null));
});

test('nullable passes null and undefined through', () => {
  assert.equal(nullable(str)(undefined), null);
  assert.equal(nullable(str)('a'), 'a');
  assert.throws(() => nullable(str)(1));
});
