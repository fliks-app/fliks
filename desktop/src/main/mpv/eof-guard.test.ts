import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrematureEof } from './eof-guard.ts';

test('an end at the duration is genuine', () => {
  assert.equal(isPrematureEof(3600, 3599.5), false);
  assert.equal(isPrematureEof(3600, 3595), false);
});

test('an end well short of the duration is premature', () => {
  assert.equal(isPrematureEof(3600, 1200), true);
});

test('an unknown duration is never premature', () => {
  assert.equal(isPrematureEof(0, 12), false);
});
