/** Subtitle appearance presets, shared between NativeEngine and Cast.
 *
 *  Each table maps the same user-facing preset keys (`'small'` / `'normal'`
 *  / `'large'` / `'xlarge'`) to a platform-calibrated value:
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
export const NATIVE_SUBTITLE_SIZE_SCALE: Record<string, number> = {
  small: 0.7,
  normal: 1.0,
  large: 1.3,
  xlarge: 1.6,
};

export const CAST_SUBTITLE_SIZE_SCALE: Record<string, number> = {
  small: 0.7,
  normal: 0.85,
  large: 1.1,
  xlarge: 1.4,
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
