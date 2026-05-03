/**
 * Lit une valeur dans l'en-tête Cookie brut (sans cookie-parser).
 */
export function parseCookieValue(
  cookieHeader: string | undefined,
  cookieName: string,
): string | null {
  if (!cookieHeader) return null;
  const prefix = `${cookieName}=`;
  for (const segment of cookieHeader.split(';')) {
    const part = segment.trim();
    if (part.startsWith(prefix)) {
      const raw = part.slice(prefix.length);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

export function getRequestCookieHeader(req: {
  headers?: { cookie?: string | string[] };
}): string | undefined {
  const c = req.headers?.cookie;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.join('; ');
  return undefined;
}
