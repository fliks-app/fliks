import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';

mock.module('electron', { namedExports: { protocol: {}, net: {} } });
const { isInside } = await import('./protocol.ts');

test('the web root and its descendants are inside, siblings sharing the prefix are not', () => {
  const root = path.resolve('/srv/web');
  assert.ok(isInside(root, root));
  assert.ok(isInside(root, path.join(root, 'a', 'b.js')));
  assert.equal(isInside(root, path.resolve('/srv/web-evil/x.js')), false);
  assert.equal(isInside(root, path.resolve('/srv/x.js')), false);
});
