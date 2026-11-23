import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MpvErrorLog } from './error-log.ts';

test('a curl or tls line classifies the error as network', () => {
  const log = new MpvErrorLog();
  log.record('error', 'tls', 'certificate verify failed');
  assert.deepEqual(log.payload('loading failed'), {
    code: 2,
    message: 'loading failed',
    detail: 'tls: certificate verify failed',
  });
});

test('a decode failure stays unclassified, warnings are ignored', () => {
  const log = new MpvErrorLog();
  log.record('warn', 'tls', 'slow');
  log.record('error', 'vd', 'Decoder failed');
  assert.equal(log.payload('x').code, -1);
  assert.equal(log.payload('x').detail, 'vd: Decoder failed');
});

test('reset clears lines and classification; only the last lines are kept', () => {
  const log = new MpvErrorLog();
  for (let i = 0; i < 20; i++) log.record('error', 'cplayer', `Failed to open ${i}`);
  assert.equal(log.payload('x').detail?.split(' | ').length, 12);
  log.reset();
  assert.equal(log.any, false);
  assert.deepEqual(log.payload('x'), { code: -1, message: 'x', detail: undefined });
});
