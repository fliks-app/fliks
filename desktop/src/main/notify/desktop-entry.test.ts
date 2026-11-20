import assert from 'node:assert/strict';
import test from 'node:test';
import { autostartEntry, quoteExecArg } from './desktop-entry.ts';

test('exec arguments are quoted and escaped', () => {
  assert.equal(quoteExecArg('/opt/My App/fliks'), '"/opt/My App/fliks"');
  assert.equal(quoteExecArg('a"b$c%d'), '"a\\"b\\$c%%d"');
  assert.match(autostartEntry(['/x', '--hidden'], 'Fliks'), /Exec="\/x" "--hidden"/);
});
