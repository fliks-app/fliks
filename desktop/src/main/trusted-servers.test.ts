import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedServer, trustServer } from './trusted-servers.ts';

test('only a reported server host is trusted', () => {
  assert.equal(isTrustedServer('https://nas.lan:8443/api'), false);
  trustServer('https://nas.lan:8443/');
  assert.equal(isTrustedServer('https://nas.lan/anything'), true);
  assert.equal(isTrustedServer('https://github.com/x'), false);
  assert.equal(isTrustedServer('not a url'), false);
});

test('a non-http server url is refused', () => {
  assert.throws(() => trustServer('fliks://app/'));
  assert.throws(() => trustServer(42));
});
