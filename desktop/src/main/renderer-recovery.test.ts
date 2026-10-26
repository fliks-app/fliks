import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReloadBudget, crashPageUrl } from './renderer-recovery.ts';

test('allows three reloads a minute, then refuses until the window passes', () => {
  let t = 0;
  const b = new ReloadBudget(() => t);
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false]);
  t = 61_000;
  assert.equal(b.take(), true);
});

test('the crash page links back to the app', () => {
  const html = decodeURIComponent(crashPageUrl('fliks://app/').split(',')[1]!);
  assert.match(html, /location\.href="fliks:\/\/app\/"/);
});
