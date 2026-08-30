/**
 * A URL that reached us from outside — an indexer feed, a plugin row — before it goes into an
 * `href`. Anything but `http:`/`https:` is refused: a `javascript:` URL in an anchor is a script
 * the viewer runs by clicking a link.
 *
 * Returns undefined rather than throwing, so a caller renders plain text instead of a dead link.
 */
export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
