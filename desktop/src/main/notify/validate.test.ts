import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLabels, parseBadge, parseNotification, parsePrefsPatch } from './validate.ts';

const base = {
  id: 'n1',
  title: 't',
  body: 'b',
  url: '/requests',
  serverUrl: 'https://fliks.example',
  user: 3,
  actions: [],
};

test('a same-origin notification is accepted, extra fields dropped', () => {
  const n = parseNotification({ ...base, image: '/api/images/x', evil: 1 });
  assert.equal(n.image, '/api/images/x');
  assert.equal('evil' in n, false);
});

test('foreign origins and protocols are refused', () => {
  assert.throws(() => parseNotification({ ...base, url: 'https://evil.example/x' }));
  assert.throws(() => parseNotification({ ...base, image: '//evil.example/x' }));
  assert.throws(() => parseNotification({ ...base, serverUrl: 'file:///etc' }));
  assert.throws(() => parseNotification({ ...base, actions: [{ id: 'a', title: 'A', kind: 'open', url: 'http://evil.example' }] }));
});

test('actions are capped at two and typed', () => {
  const a = { id: 'a', title: 'A', kind: 'call', token: 'fka_x' };
  assert.equal(parseNotification({ ...base, actions: [a, a, a] }).actions.length, 2);
  assert.throws(() => parseNotification({ ...base, actions: [{ ...a, kind: 'exec' }] }));
});

test('badge and prefs inputs', () => {
  assert.equal(parseBadge(12), 12);
  assert.throws(() => parseBadge(-1));
  assert.throws(() => parseBadge('3'));
  assert.deepEqual(parsePrefsPatch({ background: true }), { background: true });
  assert.throws(() => parsePrefsPatch({ background: 'yes' }));
  assert.deepEqual(parsePrefsPatch({ quitOnClose: false }), { quitOnClose: false });
});

test('script, backslash and scheme tricks leave the origin', () => {
  for (const url of ['javascript:alert(1)', '/\\evil.example/x', '\\\\evil.example', 'data:text/html,x', 'file:///etc/passwd'])
    assert.throws(() => parseNotification({ ...base, url }), url);
  assert.equal(parseNotification({ ...base, url: '/a/../b?x=1#y' }).url, '/a/../b?x=1#y');
});

test('labels must be short strings', () => {
  assert.deepEqual(parseLabels({ open: 'a', quit: 'b', notifications: 'c' }), { open: 'a', quit: 'b', notifications: 'c' });
  assert.throws(() => parseLabels({ open: 'a' }));
});
