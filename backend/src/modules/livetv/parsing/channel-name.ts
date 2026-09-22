/** Quality and format noise providers append to otherwise identical names. */
const NOISE =
  /\b(fhd|uhd|hd|sd|4k|8k|1080p?|720p?|576p?|480p?|h265|hevc|h264|raw|backup|multi|vip|plus\+?)\b/g;

/**
 * Comparison key for a channel name. Two entries that normalise to the same
 * key are the same channel to a human, which is what both duplicate folding
 * and name-based guide matching need.
 */
export function normalizeChannelName(raw: string): string {
  return (
    (raw ?? '')
      .toLowerCase()
      .normalize('NFD')
      // Strip diacritics so "canal+ décalé" and "canal+ decale" agree.
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
      // Country prefixes ("FR: ", "UK | ") group a playlist, they do not name a channel.
      .replace(/^[a-z]{2,3}\s*[:|]\s*/, '')
      .replace(/[^a-z0-9+]+/g, ' ')
      .replace(NOISE, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Token set of a normalised name, for the fuzzy pass. */
export function nameTokens(raw: string): Set<string> {
  return new Set(normalizeChannelName(raw).split(' ').filter(Boolean));
}

/** Jaccard similarity over pre-tokenised names, 0 to 1. Split out so a caller
 *  matching one name against many can tokenise each side once. */
export function tokenSimilarity(ta: ReadonlySet<string>, tb: ReadonlySet<string>): number {
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** Jaccard similarity over name tokens, 0 to 1. */
export function nameSimilarity(a: string, b: string): number {
  return tokenSimilarity(nameTokens(a), nameTokens(b));
}
