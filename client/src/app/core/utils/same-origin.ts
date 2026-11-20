/** `url` as a path of this origin, or null: `//host` and `/\\host` resolve to another origin, so a prefix check is not enough. */
export function sameOriginPath(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, location.origin);
    return u.origin === location.origin ? u.pathname + u.search + u.hash : null;
  } catch {
    return null;
  }
}
