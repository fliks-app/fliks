import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acceptCertificate,
  isReportedServer,
  loadTrust,
  mpvVerifies,
  noteValidChain,
  pinnedPem,
  trustServer,
  type ServerCertificate,
  type TrustPrompt,
} from './trusted-servers.ts';

const GOOD_PEM = `-----BEGIN CERTIFICATE-----
MIIBeDCCAR2gAwIBAgIULlELeswrBfk2U82W1MUZLMQNa+MwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIZ29vZC5sYW4wIBcNMjYxMTIyMTAzNzMzWhgPMjEyNjEwMjkx
MDM3MzNaMBMxETAPBgNVBAMMCGdvb2QubGFuMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEwTyQUXuSkn7+fK4aB5KZs0P8uian8085B0fN/jGNJQLvb+vbLuYKIzhW
duFRVEPCQhxc+jvXlG5jCOk3eOHdHaNNMEswHQYDVR0OBBYEFCWGFjoD0/6CQM6Y
lAzjnzrSPDLkMA8GA1UdEwEB/wQFMAMBAf8wGQYDVR0RBBIwEIIIZ29vZC5sYW6H
BH8AAAEwCgYIKoZIzj0EAwIDSQAwRgIhAJdhjIfapwpmEnRCHcsLOGoE5S5Z/ouy
HVazlAuf/MPxAiEAjfUNnUiUI6tIf8fwJOI2SAcdFWpRhemhA9taZGsLCtw=
-----END CERTIFICATE-----
`;
const OTHER_PEM = `-----BEGIN CERTIFICATE-----
MIIBdDCCARqgAwIBAgIUZPl9hiUYzroPB7U2jByIIhjByfQwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJb3RoZXIubGFuMCAXDTI2MTEyMjEwMzczM1oYDzIxMjYxMDI5
MTAzNzMzWjAUMRIwEAYDVQQDDAlvdGhlci5sYW4wWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAASFUVpwRztw0JreQO0zDf4OEVAtgWLTfZ1GrhEZJ4tRIoyIgPyuY+Ui
PJPhWd3TV8Rv8cqbPTlwC4dns1U5aKwJo0gwRjAdBgNVHQ4EFgQUdoHcedOiISFJ
+xL4K/BqndGGL3cwDwYDVR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglvdGhlci5s
YW4wCgYIKoZIzj0EAwIDSAAwRQIgJbh6Lw3iyC9IP7XTVqTNP9FnZxGagYutujb9
fct23wICIQCjHIqPZxXYuPPpfiTCttOLBkm05zttVMI0bRzRk/C/4w==
-----END CERTIFICATE-----
`;

const UNKNOWN_CA = 'net::ERR_CERT_AUTHORITY_INVALID';
const cert = (fingerprint: string): ServerCertificate => ({ fingerprint, chain: [`leaf-${fingerprint}`, `root-${fingerprint}`] });

function fresh(): { file: string; asked: TrustPrompt[]; ask: (answer: boolean) => (p: TrustPrompt) => Promise<boolean> } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-trust-')), 'trusted-servers.json');
  loadTrust(file);
  const asked: TrustPrompt[] = [];
  return { file, asked, ask: (answer) => async (p) => (asked.push(p), answer) };
}

test('only a reported server host is a server', () => {
  assert.equal(isReportedServer('https://nas.lan:8443/api'), false);
  trustServer('https://NAS.lan:8443/');
  assert.equal(isReportedServer('https://nas.lan:8443/anything'), true);
  assert.equal(isReportedServer('https://nas.lan/anything'), false);
  assert.equal(isReportedServer('http://nas.lan:8443/'), false);
  assert.equal(isReportedServer('not a url'), false);
});

test('a non-http server url is refused', () => {
  assert.throws(() => trustServer('fliks://app/'));
  assert.throws(() => trustServer(42));
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
  assert.deepEqual(asked.map((p) => [p.origin, p.changed]), [['https://first.lan', false]]);
  loadTrust(file);
  assert.equal(await acceptCertificate('https://first.lan/api', UNKNOWN_CA, cert('a'), ask(false)), true);
  assert.equal(asked.length, 1);
});

test('a refusal pins nothing and is asked again', async () => {
  const { asked, ask } = fresh();
  trustServer('https://refused.lan');
  assert.equal(await acceptCertificate('https://refused.lan/', UNKNOWN_CA, cert('a'), ask(false)), false);
  assert.equal(await acceptCertificate('https://refused.lan/', UNKNOWN_CA, cert('a'), ask(false)), false);
  assert.equal(asked.length, 2);
  assert.deepEqual(pinnedPem(), []);
});

test('a changed certificate asks as changed and keeps the old pin on refusal', async () => {
  const { asked, ask } = fresh();
  trustServer('https://changed.lan');
  await acceptCertificate('https://changed.lan/', UNKNOWN_CA, cert('a'), ask(true));
  assert.equal(await acceptCertificate('https://changed.lan/', UNKNOWN_CA, cert('b'), ask(false)), false);
  assert.equal(asked[1].changed, true);
  assert.equal(await acceptCertificate('https://changed.lan/', UNKNOWN_CA, cert('a'), ask(false)), true);
  assert.equal(asked.length, 2);
});

test('an origin that once had a valid chain never accepts an invalid one', async () => {
  const { asked, ask } = fresh();
  trustServer('https://public.example');
  noteValidChain('https://public.example/api/auth/me');
  assert.equal(await acceptCertificate('https://public.example/', UNKNOWN_CA, cert('a'), ask(true)), false);
  assert.equal(asked.length, 0);
});

test('a pinned origin keeps the right to change its certificate; http and unreported hosts note nothing', async () => {
  const { ask } = fresh();
  trustServer('https://pinned.lan');
  trustServer('http://plain.lan');
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

test('mpv verifies a pinned server only when the certificate names the address and the issuer is the one error', async () => {
  const { asked, ask } = fresh();
  for (const o of ['https://good.lan', 'https://127.0.0.1:8443', 'https://by-ip.lan', 'https://dates.lan']) trustServer(o);
  const pem = (p: string): ServerCertificate => ({ fingerprint: p.slice(60, 80), chain: [p] });
  await acceptCertificate('https://good.lan/', UNKNOWN_CA, pem(GOOD_PEM), ask(true));
  await acceptCertificate('https://127.0.0.1:8443/', UNKNOWN_CA, pem(GOOD_PEM), ask(true));
  await acceptCertificate('https://by-ip.lan/', UNKNOWN_CA, pem(OTHER_PEM), ask(true));
  await acceptCertificate('https://dates.lan/', 'net::ERR_CERT_DATE_INVALID', pem(GOOD_PEM), ask(true));
  assert.deepEqual(asked.map((p) => p.mpvUnverified), [false, false, true, true]);
  assert.equal(mpvVerifies('https://good.lan/master.m3u8'), true);
  assert.equal(mpvVerifies('https://127.0.0.1:8443/master.m3u8'), true);
  assert.equal(mpvVerifies('https://by-ip.lan/master.m3u8'), false);
  assert.equal(mpvVerifies('https://dates.lan/master.m3u8'), false);
  assert.equal(mpvVerifies('https://unpinned.example/x'), true);
});

test('the mpv bundle holds each pinned leaf and its chain once', async () => {
  const { ask } = fresh();
  trustServer('https://one.lan');
  trustServer('https://two.lan');
  await acceptCertificate('https://one.lan/', UNKNOWN_CA, cert('a'), ask(true));
  await acceptCertificate('https://two.lan/', UNKNOWN_CA, cert('a'), ask(true));
  assert.deepEqual(pinnedPem(), ['leaf-a', 'root-a']);
});

test('simultaneous errors on one origin raise one prompt', async () => {
  const { asked, ask } = fresh();
  trustServer('https://burst.lan');
  const results = await Promise.all([1, 2, 3].map(() => acceptCertificate('https://burst.lan/', UNKNOWN_CA, cert('a'), ask(true))));
  assert.deepEqual(results, [true, true, true]);
  assert.equal(asked.length, 1);
});
