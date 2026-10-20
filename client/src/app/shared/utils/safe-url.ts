/** For externally sourced URLs before an `href`: only `http:`/`https:` pass (a `javascript:` anchor runs script on click); returns undefined, not a throw. */
export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
