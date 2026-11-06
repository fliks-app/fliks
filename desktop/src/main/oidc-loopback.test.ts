import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { oidcCancel, oidcListen, oidcWait } from './oidc-loopback.ts';

const done = { title: 'Done', message: 'You can close <this> tab' };
const failed = { title: 'Failed', message: 'Try again' };
const page = { done, failed };
const get = (port: number, path: string) => fetch(`http://127.0.0.1:${port}${path}`);

test('the callback query is handed over once, with the page', async () => {
  const { id, port } = await oidcListen(page);
  const waiting = oidcWait(id, 's1');
  const res = await get(port, '/oidc?code=c1&state=s1');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /You can close &#60;this&#62; tab/);
  assert.equal(await waiting, 'code=c1&state=s1');
  await assert.rejects(get(port, '/oidc?code=c2&state=s1'));
});

test('an error redirect is handed over, with the failure page', async () => {
  const { id, port } = await oidcListen(page);
  const waiting = oidcWait(id, 's1');
  const res = await get(port, '/oidc?error=idp&state=s1');
  const html = await res.text();
  assert.match(html, /<h1>Failed<\/h1>/);
  assert.doesNotMatch(html, /Done/);
  assert.equal(await waiting, 'error=idp&state=s1');
});

test('other paths, other states and incomplete queries are refused and keep listening', async () => {
  const { id, port } = await oidcListen(page);
  assert.equal((await get(port, '/oidc?code=c&state=s')).status, 400);
  const waiting = oidcWait(id, 's');
  assert.equal((await get(port, '/')).status, 404);
  assert.equal((await get(port, '/cb?code=c&state=s')).status, 404);
  assert.equal((await get(port, '/oidc?code=c')).status, 400);
  assert.equal((await get(port, '/oidc?code=c&state=other')).status, 400);
  assert.equal((await get(port, '/oidc?state=s')).status, 400);
  await get(port, '/oidc?code=c&state=s');
  assert.equal(await waiting, 'code=c&state=s');
});

test('a request for another host name is refused and keeps listening', async () => {
  const { id, port } = await oidcListen(page);
  const waiting = oidcWait(id, 's');
  const status = await new Promise<number>((ok, fail) =>
    http.get({ host: '127.0.0.1', port, path: '/oidc?code=c&state=s', headers: { Host: 'evil.test' } }, (res) => ok(res.statusCode!)).on('error', fail),
  );
  assert.equal(status, 400);
  await get(port, '/oidc?code=c&state=s');
  assert.equal(await waiting, 'code=c&state=s');
});

test('a second listen cancels the first, and a wait on the first resolves null', async () => {
  const first = await oidcListen(page);
  const waiting = oidcWait(first.id, 's');
  const second = await oidcListen(page);
  assert.equal(await waiting, null);
  assert.equal(await oidcWait(first.id, 's'), null);
  await assert.rejects(get(first.port, '/oidc?code=c&state=s'));
  const secondWait = oidcWait(second.id, 's');
  await get(second.port, '/oidc?code=c&state=s');
  assert.equal(await secondWait, 'code=c&state=s');
});

test('a cancel closes the listener', async () => {
  const { id, port } = await oidcListen(page);
  oidcCancel(id);
  await assert.rejects(get(port, '/oidc?code=c&state=s'));
});

test('it times out with null and closes', async () => {
  const { id, port } = await oidcListen(page, 30);
  assert.equal(await oidcWait(id, 's'), null);
  await assert.rejects(get(port, '/oidc?code=c&state=s'));
});
