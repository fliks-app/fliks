import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acceptCertificate,
  httpsUpgradeOrigin,
  isReportedServer,
  loadTrust,
  mpvPinTrust,
  noteValidChain,
  trustServer,
  type ServerCertificate,
  type TrustPrompt,
} from './trusted-servers.ts';
import { CA_LEAF_PEM, CA_PEM, EXPIRED_PEM, GOOD_PEM, OTHER_PEM } from './test-certs.ts';

const UNKNOWN_CA = 'net::ERR_CERT_AUTHORITY_INVALID';
const cert = (fingerprint: string): ServerCertificate => ({ fingerprint, chain: [`leaf-${fingerprint}`, `root-${fingerprint}`] });

function fresh(): { file: string; asked: TrustPrompt[]; ask: (answer: boolean) => (p: TrustPrompt) => Promise<boolean> } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-trust-')), 'trusted-servers.json');
  loadTrust(file);
  const asked: TrustPrompt[] = [];
  return { file, asked, ask: (answer) => async (p) => (asked.push(p), answer) };
}

test('only the reported server host is a server', () => {
  assert.equal(isReportedServer('https://nas.lan:8443/api'), false);
  trustServer('https://NAS.lan:8443/');
  assert.equal(isReportedServer('https://nas.lan:8443/anything'), true);
  assert.equal(isReportedServer('https://nas.lan/anything'), false);
  assert.equal(isReportedServer('http://nas.lan:8443/'), false);
  assert.equal(isReportedServer('not a url'), false);
  trustServer('https://other.lan');
  assert.equal(isReportedServer('https://nas.lan:8443/anything'), false);
});

test('a non-http server url is refused', () => {
  assert.throws(() => trustServer('fliks://app/'));
  assert.throws(() => trustServer(42));
});

test('an http server reported with the https origin it redirects to accepts both', () => {
  trustServer('http://up.lan', httpsUpgradeOrigin('http://up.lan', 'https://up.lan/api/auth/me') ?? undefined);
  assert.equal(isReportedServer('https://up.lan/x'), true);
  assert.equal(isReportedServer('http://up.lan/x'), true);
});

test('only a same-host upgrade to https counts as the canonical origin', () => {
  assert.equal(httpsUpgradeOrigin('http://a.lan', 'https://a.lan/api/auth/me'), 'https://a.lan');
  assert.equal(httpsUpgradeOrigin('http://a.lan:8080', 'https://a.lan:8443/x'), 'https://a.lan:8443');
  assert.equal(httpsUpgradeOrigin('http://a.lan', 'https://evil.lan/x'), null);
  assert.equal(httpsUpgradeOrigin('http://a.lan', 'http://a.lan/x'), null);
  assert.equal(httpsUpgradeOrigin('https://a.lan', 'https://a.lan/x'), null);
});

test('a host the page did not report is refused without asking', async () => {
  const { asked, ask } = fresh();
  assert.equal(await acceptCertificate('https://other.lan/x', UNKNOWN_CA, cert('a'), ask(true)), false);
  assert.equal(asked.length, 0);
});

test('first use asks, pins on yes, and the pin survives a restart', async () => {
  const { file, asked, ask } = fresh();
  trustServer('https://first.lan');
  assert.equal(await acceptCertificate('https://first.lan/api', UNKNOWN_CA, cert('a'), ask(true)), true);
  assert.deepEqual(asked.map((p) => [p.origin, p.kind]), [['https://first.lan', 'new']]);
  loadTrust(file);
  assert.equal(await acceptCertificate('https://first.lan/api', UNKNOWN_CA, cert('a'), ask(false)), true);
  assert.equal(asked.length, 1);
});

test('a refusal pins nothing and is not asked again for that certificate', async () => {
  const { asked, ask } = fresh();
  trustServer('https://refused.lan');
  assert.equal(await acceptCertificate('https://refused.lan/', UNKNOWN_CA, cert('a'), ask(false)), false);
  assert.equal(await acceptCertificate('https://refused.lan/', UNKNOWN_CA, cert('a'), ask(true)), false);
  assert.equal(asked.length, 1);
  assert.equal(mpvPinTrust('https://refused.lan/'), null);
  assert.equal(await acceptCertificate('https://refused.lan/', UNKNOWN_CA, cert('b'), ask(false)), false);
  assert.equal(asked.length, 2);
});

test('a changed certificate asks as changed and keeps the old pin on refusal', async () => {
  const { asked, ask } = fresh();
  trustServer('https://changed.lan');
  await acceptCertificate('https://changed.lan/', UNKNOWN_CA, cert('a'), ask(true));
  assert.equal(await acceptCertificate('https://changed.lan/', UNKNOWN_CA, cert('b'), ask(false)), false);
  assert.equal(asked[1].kind, 'changed');
  assert.equal(await acceptCertificate('https://changed.lan/', UNKNOWN_CA, cert('a'), ask(false)), true);
  assert.equal(asked.length, 2);
});

test('an origin with a recent valid chain asks as was-valid, and the answer replaces the record', async () => {
  const { file, asked, ask } = fresh();
  trustServer('https://public.example');
  noteValidChain('https://public.example/api/auth/me');
  assert.equal(await acceptCertificate('https://public.example/', UNKNOWN_CA, cert('a'), ask(false)), false);
  assert.equal(asked[0].kind, 'was-valid');
  assert.equal(await acceptCertificate('https://public.example/', UNKNOWN_CA, cert('b'), ask(true)), true);
  loadTrust(file);
  trustServer('https://public.example');
  assert.equal(await acceptCertificate('https://public.example/', UNKNOWN_CA, cert('c'), ask(false)), false);
  assert.equal(asked[2].kind, 'changed');
});

test('a valid-chain record expires', async () => {
  const { file, asked, ask } = fresh();
  fs.writeFileSync(file, JSON.stringify({ pins: {}, validChain: { 'https://old.example': Date.now() - 31 * 24 * 3600_000 } }));
  loadTrust(file);
  trustServer('https://old.example');
  await acceptCertificate('https://old.example/', UNKNOWN_CA, cert('a'), ask(false));
  assert.equal(asked[0].kind, 'new');
});

test('a pinned origin keeps the right to change its certificate; http and unreported hosts note nothing', async () => {
  const { ask } = fresh();
  trustServer('https://pinned.lan');
  await acceptCertificate('https://pinned.lan/', UNKNOWN_CA, cert('a'), ask(true));
  noteValidChain('https://pinned.lan/x');
  noteValidChain('http://plain.lan/x');
  noteValidChain('https://stranger.lan/x');
  assert.equal(await acceptCertificate('https://pinned.lan/', UNKNOWN_CA, cert('b'), ask(true)), true);
});

test('errors that are not a server own certificate are refused without asking', async () => {
  const { asked, ask } = fresh();
  trustServer('https://revoked.lan');
  assert.equal(await acceptCertificate('https://revoked.lan/', 'net::ERR_CERT_REVOKED', cert('a'), ask(true)), false);
  assert.equal(asked.length, 0);
});

const pem = (...chain: string[]): ServerCertificate => ({ fingerprint: chain[0].slice(60, 80), chain });

async function pin(origin: string, c: ServerCertificate, error = UNKNOWN_CA): Promise<TrustPrompt> {
  const { asked, ask } = fresh();
  trustServer(origin);
  await acceptCertificate(`${origin}/`, error, c, ask(true));
  return asked[0];
}

test('mpv gets a CA file holding only the pin of a server whose certificate it can check', async () => {
  for (const [origin, c] of [
    ['https://good.lan', pem(GOOD_PEM)],
    ['https://127.0.0.1:8443', pem(GOOD_PEM)],
    ['https://ca.lan', pem(CA_LEAF_PEM, CA_PEM)],
  ] as const) {
    assert.equal((await pin(origin, c)).mpvUnverified, false, origin);
    const trust = mpvPinTrust(`${origin}/master.m3u8`);
    assert.ok(trust && 'caFile' in trust, origin);
    assert.equal(fs.readFileSync(trust.caFile, 'utf8'), c.chain.join('\n'));
  }
  assert.equal(mpvPinTrust('https://unpinned.example/x'), null);
});

test('each pinned server has its own CA file', async () => {
  const { ask } = fresh();
  trustServer('https://good.lan');
  await acceptCertificate('https://good.lan/', UNKNOWN_CA, pem(GOOD_PEM), ask(true));
  const one = mpvPinTrust('https://good.lan/');
  trustServer('https://other.lan');
  await acceptCertificate('https://other.lan/', UNKNOWN_CA, pem(OTHER_PEM), ask(true));
  const two = mpvPinTrust('https://other.lan/');
  assert.ok(one && two && 'caFile' in one && 'caFile' in two && one.caFile !== two.caFile);
});

test('a certificate mpv cannot check is pinned with its streams unverified', async () => {
  // Chromium reports an expired or wrong-name self-signed certificate as an unknown issuer.
  for (const [origin, c] of [
    ['https://by-ip.lan', pem(OTHER_PEM)],
    ['https://expired.lan', pem(EXPIRED_PEM)],
    ['https://ca.lan', pem(CA_LEAF_PEM)],
  ] as const) {
    assert.equal((await pin(origin, c)).mpvUnverified, true, origin);
    assert.deepEqual(mpvPinTrust(`${origin}/master.m3u8`), { verify: false }, origin);
  }
});

test('simultaneous errors with one certificate raise one prompt', async () => {
  const { asked, ask } = fresh();
  trustServer('https://burst.lan');
  const results = await Promise.all([1, 2, 3].map(() => acceptCertificate('https://burst.lan/', UNKNOWN_CA, cert('a'), ask(true))));
  assert.deepEqual(results, [true, true, true]);
  assert.equal(asked.length, 1);
});

test('a second certificate arriving during a prompt is asked about, not accepted with the first answer', async () => {
  const { asked, ask } = fresh();
  trustServer('https://race.lan');
  const results = await Promise.all([
    acceptCertificate('https://race.lan/', UNKNOWN_CA, cert('a'), ask(true)),
    acceptCertificate('https://race.lan/', UNKNOWN_CA, cert('b'), ask(false)),
  ]);
  assert.deepEqual(results, [true, false]);
  assert.deepEqual(asked.map((p) => p.cert.fingerprint), ['a', 'b']);
  assert.equal(await acceptCertificate('https://race.lan/', UNKNOWN_CA, cert('b'), ask(true)), false);
});
