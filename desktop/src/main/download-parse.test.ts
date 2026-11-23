import assert from 'node:assert/strict';
import test from 'node:test';
import { httpUrl, parseDownloadRequest, parseManifest, resolveExt } from './download-parse.ts';

test('a request is rebuilt field by field, extras dropped', () => {
  const r = parseDownloadRequest({ id: 'f1', url: 'https://s.example/a.mkv?token=x', filename: 'A', evil: 1 });
  assert.deepEqual(r, { id: 'f1', url: 'https://s.example/a.mkv?token=x', filename: 'A' });
  assert.equal(parseDownloadRequest({ id: 'f1', url: 'http://s/x.m3u8', quality: '1080p' }).quality, '1080p');
});

test('bad ids, urls and optional fields are refused', () => {
  assert.throws(() => parseDownloadRequest(null));
  assert.throws(() => parseDownloadRequest({ id: 3, url: 'https://s/x' }));
  assert.throws(() => parseDownloadRequest({ id: 'a', url: 'https://s/x', filename: 5 }));
  for (const url of ['file:///etc/passwd', 'javascript:1', 'not a url', 7]) assert.throws(() => httpUrl(url), String(url));
});

test('the extension comes from Content-Disposition, else Content-Type', () => {
  assert.equal(resolveExt({ 'content-disposition': 'attachment; filename="a.mkv"' }), '.mkv');
  assert.equal(resolveExt({ 'content-disposition': "attachment; filename*=UTF-8''a%20b.mp4" }), '.mp4');
  assert.equal(resolveExt({ 'content-type': 'video/webm; charset=x' }), '.webm');
  assert.equal(resolveExt({}), '.bin');
});

test('a stray % in Content-Disposition falls back to Content-Type instead of throwing', () => {
  const h = { 'content-disposition': 'attachment; filename="100%.mkv"', 'content-type': 'video/mp4' };
  assert.equal(resolveExt(h), '.mp4');
});

test('the manifest must be an object', () => {
  assert.deepEqual(parseManifest('{"a":{"id":"a"}}'), { a: { id: 'a' } });
  for (const text of ['', '{', 'null', '[]', '3']) assert.throws(() => parseManifest(text), text);
});
