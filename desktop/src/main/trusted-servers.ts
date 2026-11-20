const hosts = new Set<string>();

/** Remembers the origin (scheme, host, port) of a Fliks server the page reports; anything but http(s) is refused. */
export function trustServer(url: unknown): void {
  if (typeof url !== 'string' || url.length > 2048) throw new Error('invalid server url');
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('invalid server url');
  hosts.add(u.origin);
}

/** Whether `url` points at a reported Fliks server, the only hosts whose invalid certificate is accepted. */
export function isTrustedServer(url: string): boolean {
  try {
    return hosts.has(new URL(url).origin);
  } catch {
    return false;
  }
}
