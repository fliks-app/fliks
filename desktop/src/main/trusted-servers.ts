import { createHash, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { writeFileAtomic } from './atomic-file.ts';

/** A server's certificate as Chromium reports it: its fingerprint and the PEM chain, leaf first. */
export interface ServerCertificate {
  fingerprint: string;
  chain: string[];
}

/** What the user is asked: first sight of a certificate, a pinned one that changed, or one replacing a valid chain. */
export interface TrustPrompt {
  origin: string;
  cert: ServerCertificate;
  kind: 'new' | 'changed' | 'was-valid';
  /** mpv cannot verify this certificate, so its streams from this server go unchecked. */
  mpvUnverified: boolean;
}

/** What mpv must be given to open a stream of a pinned server; null for any other server. */
export type MpvPinTrust = { caFile: string } | { verify: false } | null;

interface Pin {
  fingerprint: string;
  chain: string[];
}

// Errors a self-hosted server's own certificate raises: unknown issuer, a name that is not the address, expiry.
const PINNABLE = new Set(['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID', 'net::ERR_CERT_DATE_INVALID']);
const VALID_CHAIN_TTL_MS = 30 * 24 * 3600_000;
const VALID_CHAIN_REFRESH_MS = 3600_000;

let servers = new Set<string>();
const pins = new Map<string, Pin>();
/** Origin → last time a request to it finished with a valid chain. */
const validChain = new Map<string, number>();
/** `origin|fingerprint` the user refused since launch. */
const refused = new Set<string>();
const serverListeners = new Set<() => void>();
let file: string | null = null;
const inflight = new Map<string, Promise<boolean>>();

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Whether FFmpeg, with only this chain as anchors, accepts it for `url`: the leaf names the host, dates hold, and it ends at a self-signed root. */
function mpvAccepts(chain: string[], url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const certs = chain.map((pem) => new X509Certificate(pem));
    const [leaf] = certs;
    if (!leaf || (net.isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host)) === undefined) return false;
    const now = Date.now();
    const root = certs[certs.length - 1];
    return (
      certs.every((c, i) => Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo) && (i === 0 || c.ca)) &&
      certs.every((c, i) => i === certs.length - 1 || c.checkIssued(certs[i + 1])) &&
      root.checkIssued(root) &&
      root.verify(root.publicKey)
    );
  } catch {
    return false;
  }
}

function save(): void {
  if (!file) return;
  const data = { pins: Object.fromEntries(pins), validChain: Object.fromEntries(validChain) };
  try {
    writeFileAtomic(file, JSON.stringify(data));
  } catch (e) {
    console.error('[tls] pins not saved:', e);
  }
}

/** Reads the pins kept from earlier runs; `path` is where later changes are written. */
export function loadTrust(path: string): void {
  file = path;
  pins.clear();
  validChain.clear();
  refused.clear();
  try {
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    for (const [origin, p] of Object.entries<Pin>(data.pins ?? {})) {
      if (typeof p?.fingerprint === 'string' && Array.isArray(p.chain)) pins.set(origin, { fingerprint: p.fingerprint, chain: p.chain });
    }
    for (const [origin, seen] of Object.entries<unknown>(data.validChain ?? {})) {
      if (typeof seen === 'number') validChain.set(origin, seen);
    }
  } catch {
    /* first run, or unreadable: nothing is pinned */
  }
}

/** Makes `url`'s origin the page's one Fliks server, replacing the previous one; `alsoOrigin` is the https origin it redirects to. */
export function trustServer(url: unknown, alsoOrigin?: string): void {
  if (typeof url !== 'string' || url.length > 2048) throw new Error('invalid server url');
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('invalid server url');
  servers = new Set([u.origin, ...(alsoOrigin ? [alsoOrigin] : [])]);
  for (const l of serverListeners) l();
}

/** The origin an http server's first redirect names when it only upgrades the same host to https; null otherwise. */
export function httpsUpgradeOrigin(from: string, location: string): string | null {
  try {
    const base = new URL(from);
    const to = new URL(location, base);
    return base.protocol === 'http:' && to.protocol === 'https:' && to.hostname === base.hostname ? to.origin : null;
  } catch {
    return null;
  }
}

/** The origins the page reported as its Fliks server. */
export function reportedOrigins(): string[] {
  return [...servers];
}

/** Runs `fn` whenever the reported server changes. */
export function onServerChanged(fn: () => void): void {
  serverListeners.add(fn);
}

/** Whether `url` is on an origin the page reported as its Fliks server. */
export function isReportedServer(url: string): boolean {
  const origin = originOf(url);
  return origin !== null && servers.has(origin);
}

/** A request to a reported https server finished with no certificate error: its chain is valid, so a bad one soon after is an attack. */
export function noteValidChain(url: string): void {
  const origin = originOf(url);
  if (!origin?.startsWith('https:') || !servers.has(origin) || pins.has(origin)) return;
  const now = Date.now();
  if (now - (validChain.get(origin) ?? 0) < VALID_CHAIN_REFRESH_MS) return;
  validChain.set(origin, now);
  save();
}

/** Whether the invalid certificate a reported server presented is accepted: pinned, or the user says so (one prompt per origin at a time, a refusal kept for the session). */
export async function acceptCertificate(
  url: string,
  error: string,
  cert: ServerCertificate,
  ask: (prompt: TrustPrompt) => Promise<boolean>,
): Promise<boolean> {
  const origin = originOf(url);
  if (!origin || !servers.has(origin)) return false;
  const pin = pins.get(origin);
  if (pin?.fingerprint === cert.fingerprint) return true;
  if (!PINNABLE.has(error) || refused.has(`${origin}|${cert.fingerprint}`)) return false;
  const pending = inflight.get(origin);
  if (pending) {
    // The answer may have pinned or refused this very certificate: decide again once it is in.
    await pending.catch(() => {});
    return acceptCertificate(url, error, cert, ask);
  }
  const wasValid = Date.now() - (validChain.get(origin) ?? 0) < VALID_CHAIN_TTL_MS;
  const kind = wasValid ? 'was-valid' : pin ? 'changed' : 'new';
  const decision = ask({ origin, cert, kind, mpvUnverified: !mpvAccepts(cert.chain, url) }).then((ok) => {
    if (ok) {
      pins.set(origin, { fingerprint: cert.fingerprint, chain: cert.chain });
      validChain.delete(origin);
      save();
    } else {
      refused.add(`${origin}|${cert.fingerprint}`);
    }
    return ok;
  });
  inflight.set(origin, decision);
  try {
    return await decision;
  } finally {
    inflight.delete(origin);
  }
}

/** How mpv opens `url`: a pinned server FFmpeg can check gets a CA file holding only its pin, one it cannot opens unverified. */
export function mpvPinTrust(url: string): MpvPinTrust {
  const origin = originOf(url);
  const pin = origin ? pins.get(origin) : undefined;
  if (!origin || !pin) return null;
  if (!mpvAccepts(pin.chain, url)) return { verify: false };
  if (!file) throw new Error('trust store not loaded');
  const name = createHash('sha256').update(origin).digest('hex').slice(0, 16);
  const caFile = path.join(path.dirname(file), 'tls-pins', `${name}.pem`);
  writeFileAtomic(caFile, pin.chain.join('\n'));
  return { caFile };
}
