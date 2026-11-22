import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mpvLoadFileOptions, mpvLoadRequest } from './load-options.ts';

test('every load switches the subtitle off so mpv never auto-picks one', () => {
  assert.deepEqual(mpvLoadFileOptions({ url: 'u' }), ['sid=no']);
});

test('start time and audio language ride along as file-local options', () => {
  assert.deepEqual(
    mpvLoadFileOptions({ url: 'u', startTime: 12.34567, audioLanguage: 'fre' }),
    ['sid=no', 'start=+12.346', 'alang=fre'],
  );
});

test('an audio language that is not a language code is dropped', () => {
  for (const bad of ['fre,sid=1', 'fr-FR', 'f', 'frenc', 'fr\n', '']) {
    assert.deepEqual(mpvLoadFileOptions({ url: 'u', audioLanguage: bad }), ['sid=no'], bad);
  }
  assert.deepEqual(mpvLoadFileOptions({ url: 'u', audioLanguage: 'FR' }), ['sid=no', 'alang=fr']);
});

test('a zero start time and an empty language add nothing', () => {
  assert.deepEqual(mpvLoadFileOptions({ url: 'u', startTime: 0, audioLanguage: '' }), ['sid=no']);
});

test('the addon request keeps the renderer options next to the file options', () => {
  assert.deepEqual(mpvLoadRequest({ url: 'u', videoCrop: '1x1+0+0' }), {
    url: 'u',
    videoCrop: '1x1+0+0',
    fileOptions: ['sid=no'],
  });
});

test('a pinned server mpv cannot verify opens with its own check off', async () => {
  const { trustServer, acceptCertificate } = await import('../trusted-servers.ts');
  trustServer('https://by-ip.lan');
  await acceptCertificate('https://by-ip.lan/', 'net::ERR_CERT_AUTHORITY_INVALID', { fingerprint: 'f', chain: ['not a certificate'] }, async () => true);
  assert.deepEqual(mpvLoadFileOptions({ url: 'https://by-ip.lan/m.m3u8' }), ['sid=no', 'tls-verify=no']);
  assert.deepEqual(mpvLoadFileOptions({ url: 'https://other.lan/m.m3u8' }), ['sid=no']);
});

test('a pinned server mpv can verify opens against its own CA file, quoted', async () => {
  const { trustServer, acceptCertificate, loadTrust } = await import('../trusted-servers.ts');
  const { GOOD_PEM } = await import('../test-certs.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-load-'));
  loadTrust(path.join(dir, 'trusted-servers.json'));
  trustServer('https://good.lan');
  await acceptCertificate('https://good.lan/', 'net::ERR_CERT_AUTHORITY_INVALID', { fingerprint: 'g', chain: [GOOD_PEM] }, async () => true);
  const [, ca] = mpvLoadFileOptions({ url: 'https://good.lan/m.m3u8' });
  const file = path.join(dir, 'tls-pins');
  assert.match(ca, new RegExp(`^tls-ca-file=%${Buffer.byteLength(path.join(file, '0123456789abcdef.pem'))}%`));
  assert.ok(ca.includes(file));
});
