import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-log-'));
mock.module('electron', { namedExports: { app: { getPath: () => logs, isPackaged: true } } });
const { appendLog, trimLog } = await import('./log-file.ts');
const file = path.join(logs, 'desktop.log');
const MB = 1024 * 1024;
const lines = (bytes: number) => ('x'.repeat(99) + '\n').repeat(Math.ceil(bytes / 100));

test('trimLog keeps the tail, from the start of a line', () => {
  const p = path.join(logs, 'a.log');
  fs.writeFileSync(p, 'old\n' + lines(1000) + 'last\n');
  trimLog(p, 500, 250);
  const out = fs.readFileSync(p, 'utf8');
  assert.ok(out.length <= 250 && out.endsWith('last\n') && out.startsWith('x'));
  fs.writeFileSync(p, 'short\n');
  trimLog(p, 500, 250);
  assert.equal(fs.readFileSync(p, 'utf8'), 'short\n');
});

test('the size is checked at the first write, then every 200 writes', () => {
  fs.writeFileSync(file, lines(6 * MB));
  appendLog('first');
  assert.ok(fs.statSync(file).size < 2 * MB);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith(' first\n'));

  fs.writeFileSync(file, lines(6 * MB));
  for (let i = 0; i < 199; i++) appendLog('between');
  assert.ok(fs.statSync(file).size > 6 * MB);
  appendLog('check');
  assert.ok(fs.statSync(file).size < 2 * MB);
});
