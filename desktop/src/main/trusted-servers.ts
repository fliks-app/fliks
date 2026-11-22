import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

/** A server's certificate as Chromium reports it: its fingerprint and the PEM chain, leaf first. */
export interface ServerCertificate {
  fingerprint: string;
  chain: string[];
}

/** What the user is asked: first sight of a certificate, or a pinned one that changed. */
export interface TrustPrompt {
  origin: string;
  cert: ServerCertificate;
  changed: boolean;
  /** mpv cannot verify this certificate, so its streams from this server go unchecked. */
  mpvUnverified: boolean;
}

interface Pin {
  fingerprint: string;
  chain: string[];
  mpvVerify: boolean;
}

// Errors a self-hosted server's own certificate raises: unknown issuer, a name that is not the address, expiry.
const PINNABLE = new Set(['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID', 'net::ERR_CERT_DATE_INVALID']);
// FFmpeg also checks the name and the dates: a certificate that fails either passes Chromium's pin but not its handshake.
const MPV_VERIFIABLE = 'net::ERR_CERT_AUTHORITY_INVALID';

const servers = new Set<string>();
const pins = new Map<string, Pin>();
const validChain = new Set<string>();
const listeners = new Set<() => void>();
let file: string | null = null;
const inflight = new Map<string, Promise<boolean>>();

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Whether the leaf certificate names the host `url` points at, as FFmpeg's check will. */
function namesHost(leaf: string | undefined, url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const cert = new X509Certificate(leaf ?? '');
    return (net.isIP(host) ? cert.checkIP(host) : cert.checkHost(host)) !== undefined;
  } catch {
    return false;
  }
}

function save(): void {
  for (const l of listeners) l();
  if (!file) return;
  const data = { pins: Object.fromEntries(pins), validChain: [...validChain] };
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) {
    console.error('[tls] pins not saved:', e);
  }
}

/** Reads the pins kept from earlier runs; `path` is where later changes are written. */
export function loadTrust(path: string): void {
  file = path;
  pins.clear();
  validChain.clear();
  try {
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    for (const [origin, p] of Object.entries<Pin>(data.pins ?? {})) {
      if (typeof p?.fingerprint === 'string' && Array.isArray(p.chain)) pins.set(origin, p);
    }
    for (const o of data.validChain ?? []) validChain.add(String(o));
  } catch {
    /* first run, or unreadable: nothing is pinned */
  }
}

/** Remembers the origin (scheme, host, port) of a Fliks server the page reports; anything but http(s) is refused. */
export function trustServer(url: unknown): void {
  if (typeof url !== 'string' || url.length > 2048) throw new Error('invalid server url');
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('invalid server url');
  servers.add(u.origin);
}

/** Whether `url` is on an origin the page reported as its Fliks server. */
export function isReportedServer(url: string): boolean {
  const origin = originOf(url);
  return origin !== null && servers.has(origin);
}

/** A request to a reported https server finished with no certificate error: its chain is valid, so a bad one later is an attack. */
export function noteValidChain(url: string): void {
  const origin = originOf(url);
  if (!origin?.startsWith('https:') || !servers.has(origin) || pins.has(origin) || validChain.has(origin)) return;
  validChain.add(origin);
  save();
}

/**
 * Whether the invalid certificate a reported server presented is accepted.
 * Pinned and unchanged: yes. An origin that once had a valid chain, or an error that is not a server's own
 * certificate: no. Otherwise the user decides, once per origin at a time.
 */
export async function acceptCertificate(
  url: string,
  error: string,
  cert: ServerCertificate,
  ask: (prompt: TrustPrompt) => Promise<boolean>,
): Promise<boolean> {
  const origin = originOf(url);
  if (!origin || !servers.has(origin)) return false;
  const mpvVerify = error === MPV_VERIFIABLE && namesHost(cert.chain[0], url);
  const pin = pins.get(origin);
  if (pin?.fingerprint === cert.fingerprint) {
    if (pin.mpvVerify !== mpvVerify) {
      pin.mpvVerify = mpvVerify;
      save();
    }
    return true;
  }
  if (!PINNABLE.has(error) || validChain.has(origin)) return false;
  const pending = inflight.get(origin);
  if (pending) return pending;
  const decision = ask({ origin, cert, changed: pin !== undefined, mpvUnverified: !mpvVerify }).then((ok) => {
    if (ok) {
      pins.set(origin, { fingerprint: cert.fingerprint, chain: cert.chain, mpvVerify });
      save();
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

/** Every pinned certificate with its chain, as the PEM entries mpv adds to its trust file. */
export function pinnedPem(): string[] {
  return [...new Set([...pins.values()].flatMap((p) => p.chain))];
}

/** Whether mpv can verify the certificate of the server `url` points at; false only for a pinned origin it cannot. */
export function mpvVerifies(url: string): boolean {
  const origin = originOf(url);
  return !(origin && pins.get(origin)?.mpvVerify === false);
}

/** Runs `fn` after every change to the pins or to the valid-chain record, so mpv's trust file follows. */
export function onPinsChanged(fn: () => void): void {
  listeners.add(fn);
}
