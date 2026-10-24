export interface EmojiEntry {
  emoji: string;
  label: string;
  /** Normalized label and tags, what a query is matched against. */
  haystack: string;
}

export interface EmojiGroup {
  key: string;
  label: string;
  emojis: EmojiEntry[];
}

/** Lowercase, accent-free, punctuation folded to single spaces: "doigt d’honneur" and "Doigt d honneur" match. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Entries whose label or tags contain every word of `query`; all of them for an empty query. */
export function searchEmojis(entries: readonly EmojiEntry[], query: string): EmojiEntry[] {
  const words = normalizeText(query).split(' ').filter(Boolean);
  return entries.filter((e) => words.every((w) => e.haystack.includes(w)));
}
