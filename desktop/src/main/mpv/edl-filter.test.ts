import assert from 'node:assert/strict';
import test from 'node:test';
import { muteFilterCommands, muteFilters } from './edl-filter.ts';

test('no ranges yields no filter and removes only what is installed', () => {
  assert.deepEqual(muteFilters([]), []);
  assert.deepEqual(muteFilterCommands([], 0), { commands: [], count: 0 });
  assert.deepEqual(muteFilterCommands([], 2).commands, [
    ['af', 'remove', '@fliksedl0'],
    ['af', 'remove', '@fliksedl1'],
  ]);
});

test('one range is widened by lead and trail', () => {
  assert.deepEqual(muteFilters([{ start: 1.5, end: 2.25 }]), [
    "@fliksedl0:lavfi=[volume=volume=0:enable='between(t,1.45,2.28)']",
  ]);
});

test('lead never goes below 0', () => {
  assert.ok(muteFilters([{ start: 0.01, end: 1 }])[0].includes('between(t,0,1.03)'));
});

test('numbers keep at most 3 decimals, no exponent, no locale comma', () => {
  const f = muteFilters([{ start: 0.1 + 0.2 + 0.05, end: 5 - 0.03 }])[0];
  assert.ok(f.includes('between(t,0.3,5)'));
  const orig = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = () => '1,5';
  try {
    assert.ok(muteFilters([{ start: 1.5, end: 2 }])[0].includes('between(t,1.45,2.03)'));
  } finally {
    Number.prototype.toLocaleString = orig;
  }
});

test('invalid ranges are dropped', () => {
  assert.deepEqual(muteFilters([{ start: 3, end: 3 }, { start: NaN, end: 4 }]), []);
});

test('commands remove the previous labels then add the new ones', () => {
  const c = muteFilterCommands([{ start: 1, end: 2 }], 1);
  assert.equal(c.count, 1);
  assert.deepEqual(c.commands.map((x) => x.slice(0, 3).join(' ')).map((x) => x.split(' ').slice(0, 2).join(' ')), ['af remove', 'af add']);
});

test('thousands of ranges split into chained filters of at most 100 terms', () => {
  const r = Array.from({ length: 5000 }, (_, i) => ({ start: i * 10, end: i * 10 + 1 }));
  const f = muteFilters(r);
  assert.equal(f.length, 50);
  assert.ok(f.every((x) => x.split('between').length - 1 === 100));
  assert.ok(f[49].startsWith('@fliksedl49:'));
});
