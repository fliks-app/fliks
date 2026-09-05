export type HearingImpairedMode = 'prefer' | 'avoid' | 'require' | 'forbid';

export interface SubtitleLanguageItem {
  isoCode: string;
  name: string;
  forced: boolean;
  hi: boolean;
  /**
   * Explicit per-language override, layered on top of the compact `hi`
   * boolean every stored item carries: `hi=true` → `prefer`, `hi=false`
   * → `avoid` when this field is absent.
   *
   * - `prefer`:  HI subs score the 1-point bit; non-HI don't.
   * - `avoid`:   non-HI subs score the bit; HI don't. (Default.)
   * - `require`: HI candidates only; non-HI filtered out before scoring.
   * - `forbid`:  non-HI only; HI candidates filtered out.
   */
  hearingImpaired?: HearingImpairedMode;
}

/** Resolves a language item's effective HI mode from the compact `hi`
 *  boolean — every stored item carries `hi`, not `hearingImpaired`. */
export function resolveHearingImpairedMode(
  item: SubtitleLanguageItem,
): HearingImpairedMode {
  return item.hearingImpaired ?? (item.hi ? 'prefer' : 'avoid');
}

/** Filename tokens marking a track forced / hearing-impaired, parsed
 *  right-to-left out of `<video>.<lang>.<flags>.<ext>` sidecar names. */
export const FORCED_FLAG_TOKENS = new Set(['forced', 'foreign']);
export const HI_FLAG_TOKENS = new Set(['hi', 'cc', 'sdh']);

const FORCED_TITLE_RE = /(?<!non[\s._-])(?<!not\s)\b(forced|foreign[\s._-]?parts?)\b/i;
// 'hi' is deliberately absent: as a bare word in a stream title it's far more
// often Hindi (or English) than a hearing-impaired marker.
const HI_TITLE_RE = /\b(sdh|cc|hearing[\s._-]?impaired|closed[\s._-]?captions?)\b/i;

/** Flags a muxer expressed only in the stream title: plenty of remuxes ship
 *  `title="Forced"` with `disposition.forced=0`. */
export function subtitleFlagsFromTitle(title?: string | null): {
  forced: boolean;
  hearingImpaired: boolean;
} {
  const t = title ?? '';
  return {
    forced: FORCED_TITLE_RE.test(t),
    hearingImpaired: HI_TITLE_RE.test(t),
  };
}

/** What a profile language item asks for beyond the language itself. */
export interface SubtitleRequestFlags {
  forced?: boolean;
  hearingImpairedMode?: HearingImpairedMode;
}

/** Minimal shape of anything that can answer a request: a stored row, an
 *  embedded track, or a provider candidate. */
export interface SubtitleFlagsProbe {
  forced?: boolean | null;
  hearingImpaired?: boolean | null;
}

export function requestFlagsOf(item: SubtitleLanguageItem): SubtitleRequestFlags {
  // Normalised, so a legacy profile item stored without `forced` still states
  // a constraint rather than reading as "any".
  return {
    forced: !!item.forced,
    hearingImpairedMode: resolveHearingImpairedMode(item),
  };
}

/**
 * True when a subtitle carries the flags the request asks for. A stated
 * `forced` is an exact match in both directions: a forced track holds only
 * foreign dialogue and can never stand in for a full one, nor a full one for a
 * forced request. An absent `forced` states no constraint — a hand-driven
 * search must still see every candidate. HI follows the mode: `require` /
 * `forbid` are hard filters, `prefer` / `avoid` only order candidates (see
 * `prefersHearingImpaired`).
 */
export function matchesRequestedFlags(
  sub: SubtitleFlagsProbe,
  req: SubtitleRequestFlags,
): boolean {
  if (req.forced !== undefined && !!sub.forced !== req.forced) return false;
  const mode = req.hearingImpairedMode ?? 'avoid';
  if (mode === 'require') return !!sub.hearingImpaired;
  if (mode === 'forbid') return !sub.hearingImpaired;
  return true;
}

/** Which side of the soft `prefer`/`avoid` modes a candidate should sit on. */
export function prefersHearingImpaired(req: SubtitleRequestFlags): boolean {
  const mode = req.hearingImpairedMode ?? 'avoid';
  return mode === 'require' || mode === 'prefer';
}
