import * as net from 'net';

/** IPv4 space a plugin-supplied webhook may never target, as CIDRs. Beyond the
 *  obvious private ranges: CGNAT is real internal space on many hosts, and the
 *  reserved/benchmark/multicast blocks have no business receiving a webhook. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // RFC6598 CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // RFC2544 benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0) >>> 0;
}

function inV4Cidr(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((v4ToInt(ip) & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
}

/** Expand any legal IPv6 text to its eight 16-bit groups. */
function expandV6(ip: string): number[] | null {
  const [head, tail] = ip.split('::');
  const parse = (s: string) =>
    s ? s.split(':').filter(Boolean).map((g) => parseInt(g, 16)) : [];
  // A trailing dotted quad (mapped or NAT64) occupies the last two groups.
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  const strip = (s: string) => (embedded ? s.replace(/(:)?[\d.]+$/, '') : s);
  const groups = embedded
    ? (() => {
        const n = v4ToInt(embedded);
        return [(n >>> 16) & 0xffff, n & 0xffff];
      })()
    : [];
  const left = parse(strip(head ?? ''));
  const right = tail === undefined ? [] : parse(strip(tail));
  const known = left.length + right.length + groups.length;
  if (tail === undefined) {
    return known === 8 ? [...left, ...groups] : null;
  }
  if (known > 8) return null;
  return [...left, ...new Array(8 - known).fill(0), ...right, ...groups];
}

/**
 * True if `ip` is an address a plugin-supplied webhook may not target:
 * loopback, link-local, private, CGNAT, reserved or multicast.
 *
 * Works on the numeric value, not the text shape — `::ffff:127.0.0.1` and
 * `0:0:0:0:0:ffff:127.0.0.1` are the same address, and a check that only
 * recognises the compressed spelling is bypassed by writing the other one.
 * Anything that is not a literal IP is refused rather than guessed at.
 */
export function isInternalAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 0) return true;

  if (version === 4) {
    return BLOCKED_V4.some(([base, bits]) => inV4Cidr(ip, base, bits));
  }

  const groups = expandV6(ip);
  if (!groups) return true;

  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) both carry a real
  // IPv4 destination in the last two groups; judge it as IPv4.
  const isMapped =
    groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isNat64 =
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((g) => g === 0);
  if (isMapped || isNat64) {
    const n = (groups[6] << 16) + groups[7];
    const v4 = [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join('.');
    return BLOCKED_V4.some(([base, bits]) => inV4Cidr(v4, base, bits));
  }

  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}
