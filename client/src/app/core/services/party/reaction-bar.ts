export const MAX_BAR = 8;

/** The stored bar without duplicates or emojis outside `known`; `known` is null while the emoji data is not loaded, and everything passes. The defaults when nothing is left. */
export function sanitizeBar(stored: readonly string[] | null, known: ReadonlySet<string> | null, defaults: readonly string[]): string[] {
  const kept = (stored ?? []).filter((e, i, l) => (known?.has(e) ?? true) && l.indexOf(e) === i).slice(0, MAX_BAR);
  return kept.length ? kept : [...defaults];
}

/** Adds or removes `emoji`; `null` when the change is refused (bar full, or last emoji). */
export function toggleBar(bar: readonly string[], emoji: string): string[] | null {
  if (bar.includes(emoji)) return bar.length > 1 ? bar.filter((e) => e !== emoji) : null;
  return bar.length < MAX_BAR ? [...bar, emoji] : null;
}
