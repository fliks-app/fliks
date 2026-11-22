/** Splits a standalone year (1888..2100) off a query; a query that is only a year stays whole. */
export function splitYear(q: string): { title: string; year: number | null } {
  const words = q.trim().split(/\s+/);
  const i = words.map((w) => /^\d{4}$/.test(w) && +w >= 1888 && +w <= 2100).lastIndexOf(true);
  if (i < 0 || words.length === 1) return { title: q, year: null };
  return { title: words.filter((_, j) => j !== i).join(' '), year: +words[i]! };
}
