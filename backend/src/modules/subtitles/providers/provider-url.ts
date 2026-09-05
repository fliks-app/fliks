/**
 * Resolve a provider download target against that provider's own base.
 *
 * `providerFileId` travels from the search response through the API client and
 * back, so it is caller-controlled. Building a URL by concatenation lets a
 * value like `@attacker.tld/x` move the request to another host, whose body is
 * then written into the media library as a sidecar. `new URL(rel, base)`
 * resolves instead of concatenating, and the origin check rejects anything
 * absolute that points elsewhere.
 */
export function providerUrl(base: string, candidate: string): string {
  let resolved: URL;
  try {
    resolved = new URL(candidate, base);
  } catch {
    throw new Error(`Invalid download path: ${candidate}`);
  }
  if (resolved.origin !== new URL(base).origin) {
    throw new Error(`Refusing to download from ${resolved.origin}`);
  }
  return resolved.toString();
}
