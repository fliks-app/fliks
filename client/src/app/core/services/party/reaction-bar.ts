export const MAX_BAR = 8;

/** The stored bar without emojis the catalog dropped; the defaults when nothing valid is left. */
export function sanitizeBar(stored: readonly string[] | null, catalog: readonly string[], defaults: readonly string[]): string[] {
  const kept = (stored ?? []).filter((e, i, l) => catalog.includes(e) && l.indexOf(e) === i).slice(0, MAX_BAR);
  return kept.length ? kept : defaults.filter((e) => catalog.includes(e));
}

/** Adds or removes `emoji`; `null` when the change is refused (bar full, or last emoji). */
export function toggleBar(bar: readonly string[], emoji: string): string[] | null {
  if (bar.includes(emoji)) return bar.length > 1 ? bar.filter((e) => e !== emoji) : null;
  return bar.length < MAX_BAR ? [...bar, emoji] : null;
}
