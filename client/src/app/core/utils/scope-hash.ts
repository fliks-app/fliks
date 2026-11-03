/** Short stable hash of a (server, user) scope suffix, used to prefix on-device file names. */
export function scopeHash(suffix: string): string {
  let h = 5381;
  for (const c of suffix) h = (Math.imul(h, 33) + c.charCodeAt(0)) >>> 0;
  return h.toString(16);
}
