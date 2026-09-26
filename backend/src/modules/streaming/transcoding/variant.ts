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
 * - `remux`: video-copy / audio-remux path (DirectStream). It muxes the
 *   picked audio track alone, cut on the keyframe grid or, without one, on
 *   the uniform grid, so both key its bucket.
 *
 * Centralising the suffix logic here removes the foot-gun of editing
 * inline `${baseHash}-early` / `${baseHash}-remux` template
 * literals — the strip regex, the prefix check, and the variant
 * encoder all live in one place.
 */
export type SessionVariant =
  | { kind: 'main' }
  | { kind: 'early' }
  | { kind: 'remux'; audioIndex: number; keyframeGrid: boolean };

/** Singleton instances for the variants that take no parameters —
 *  saves an allocation per spawn. */
export const VARIANT_MAIN: SessionVariant = { kind: 'main' };
export const VARIANT_EARLY: SessionVariant = { kind: 'early' };

export function remuxVariant(
  audioIndex: number | undefined,
  keyframeGrid: boolean,
): SessionVariant {
  return { kind: 'remux', audioIndex: audioIndex ?? 0, keyframeGrid };
}

/** Suffix appended to a base profile hash to disambiguate the variant
 *  on disk and in the session map. Empty for `main`. */
export function variantSuffix(variant: SessionVariant): string {
  switch (variant.kind) {
    case 'main':
      return '';
    case 'early':
      return '-early';
    case 'remux':
      return `-remux-a${variant.audioIndex}${variant.keyframeGrid ? '' : '-u'}`;
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

const VARIANT_SUFFIX_RE = /-(?:early|remux-a\d+(?:-u)?)$/;

/** Strip any known variant suffix off a cache key to recover the base
 *  profile hash that the live-session registry tracks. The registry
 *  has one entry per client; every variant of the client's transcode
 *  rolls up to the same base hash. */
export function baseProfileHash(cacheKey: string): string {
  return cacheKey.replace(VARIANT_SUFFIX_RE, '');
}
