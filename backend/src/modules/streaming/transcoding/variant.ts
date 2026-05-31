/**
 * Variant flavours a single `(file, user, profile)` triple can be
 * transcoded into. Each one lives in its own cache directory and its
 * own session-map entry so they never collide on disk or in memory:
 *
 * - `main`: the regular video transcode. Cache key is the bare base
 *   profile hash.
 * - `early`: short-lived companion that produces seg-0/seg-1 in
 *   parallel with a main session that's seeking mid-file. Same codec
 *   as main; suffix keeps the two in distinct cache dirs.
 * - `remux`: video-copy / audio-remux path (DirectStream). Different
 *   ffmpeg arg set than main; gets its own bucket.
 * - `audio`: per-audio-track HLS audio rendition. One bucket per
 *   audioIndex so multi-audio playbacks don't share a writer.
 *
 * Centralising the suffix logic here removes the foot-gun of editing
 * five inline `${baseHash}-early` / `${baseHash}-a${n}` template
 * literals — the strip regex, the prefix check, and the variant
 * encoder all live in one place.
 */
export type SessionVariant =
  | { kind: 'main' }
  | { kind: 'early' }
  | { kind: 'remux' }
  | { kind: 'audio'; audioIndex: number };

/** Singleton instances for the variants that take no parameters —
 *  saves an allocation per spawn. */
export const VARIANT_MAIN: SessionVariant = { kind: 'main' };
export const VARIANT_EARLY: SessionVariant = { kind: 'early' };
export const VARIANT_REMUX: SessionVariant = { kind: 'remux' };

/** Suffix appended to a base profile hash to disambiguate the variant
 *  on disk and in the session map. Empty for `main`. */
export function variantSuffix(variant: SessionVariant): string {
  switch (variant.kind) {
    case 'main':
      return '';
    case 'early':
      return '-early';
    case 'remux':
      return '-remux';
    case 'audio':
      return `-a${variant.audioIndex}`;
  }
}

/** Compose a variant cache key from a base profile hash. The result is
 *  what gets stored as `session.cacheKey` and used as the directory
 *  segment under `/tmp/transcode/cache/<user>/<file>/...`. */
export function variantHash(
  baseHash: string,
  variant: SessionVariant,
): string {
  return `${baseHash}${variantSuffix(variant)}`;
}

const VARIANT_SUFFIX_RE = /-(?:early|remux|a\d+)$/;

/** Strip any known variant suffix off a cache key to recover the base
 *  profile hash that the live-session registry tracks. The registry
 *  has one entry per client; every variant of the client's transcode
 *  rolls up to the same base hash. */
export function baseProfileHash(cacheKey: string): string {
  return cacheKey.replace(VARIANT_SUFFIX_RE, '');
}
