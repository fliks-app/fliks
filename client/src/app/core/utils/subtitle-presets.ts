/** Subtitle appearance presets, shared between NativeEngine and Cast.
 *
 *  Each table maps the same user-facing preset keys (`'xsmall'` / `'small'` /
 *  `'normal'` / `'large'` / `'xlarge'`) to a platform-calibrated value:
 *
 *  - **Native** runs on ExoPlayer's `CaptionStyleCompat` and iOS
 *    `AVTextStyleRule`. Both define `1.0` as the platform's default
 *    subtitle size, which already accounts for screen DPI / accessibility
 *    settings — so `normal: 1.0` means "honour the user's OS setting".
 *  - **Cast** sets `TextTrackStyle.fontScale` on the receiver. The
 *    default-size receiver renders subtitles ~17% larger than the local
 *    Android player at scale 1.0, so the Cast table is calibrated lower
 *    to match perceived size: `normal: 0.85`.
 *
 *  The divergence is intentional. If a sender ever sees subtitles that
 *  look bigger on Cast than on the same device's local playback, the
 *  Cast scale is the lever to retune — not the Native one. */

/** Text height at scale 1.0, as a fraction of the surface's *short* side, for
 *  the engines that own their renderer. The short side is orientation-
 *  invariant, so a cue keeps its size across a rotation; the full height would
 *  oversize portrait, where the picture is mostly letterbox. The ExoPlayer and
 *  AVPlayer overlays hardcode the same value (SubtitleOverlay.java,
 *  SubtitleOverlayView.swift) — retune the three together. */
export const SUBTITLE_HEIGHT_FRACTION = 0.035;

/** Same ladder for DOM cues, one notch lower: the browser path is mostly read
 *  on a desktop monitor, further away than a held device. TVs sit on this path
 *  too but default to the `large` preset. */
export const DOM_SUBTITLE_HEIGHT_FRACTION = 0.03;

/** Floor under the fraction, in CSS px / dp / pt. A phone's short side is
 *  ~390 of those, so the fraction alone lands around 12px — unreadable at
 *  arm's length. Scaled by the preset like the fraction is, so the ladder
 *  keeps its steps. Repeated by the two native renderers
 *  (MIN_TEXT_SIZE_SP, minPointSize). */
export const SUBTITLE_MIN_TEXT_PX = 18;

export const NATIVE_SUBTITLE_SIZE_SCALE: Record<string, number> = {
  xsmall: 0.7,
  small: 0.85,
  normal: 1.0,
  large: 1.15,
  xlarge: 1.3,
};

export const CAST_SUBTITLE_SIZE_SCALE: Record<string, number> = {
  xsmall: 0.7,
  small: 0.775,
  normal: 0.85,
  large: 0.975,
  xlarge: 1.1,
};

/** Foreground colour in `#RRGGBB` (Android / iOS native renderers want
 *  this form; the Cast helper appends the alpha byte). */
export const SUBTITLE_FG_HEX: Record<string, string> = {
  white: '#FFFFFF',
  yellow: '#FFFF00',
  green: '#00FF00',
  cyan: '#00FFFF',
};

/** Background colour as Android-format ARGB hex (`#AARRGGBB`). The Cast
 *  receiver wants `#RRGGBBAA` instead — `cast.service` re-orders the
 *  bytes when it sends. */
export const SUBTITLE_BG_ARGB: Record<string, string> = {
  transparent: 'transparent',
  semi: '#80000000',
  black: '#E6000000',
};

/** Edge effect keys forwarded to the native plugins; the Cast helper
 *  remaps these to the `TextTrackEdgeType` enum at send time. */
export const SUBTITLE_EDGE_KEY: Record<string, string> = {
  none: 'none',
  drop: 'drop_shadow',
  outline: 'outline',
  raised: 'raised',
};
