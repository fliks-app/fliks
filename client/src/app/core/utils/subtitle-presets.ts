/** Subtitle appearance presets shared by NativeEngine and Cast: native `normal: 1.0` honours the OS size,
 *  Cast is calibrated lower (`normal: 0.85`) since its receiver renders ~17% larger; retune Cast, not Native. */

/** Text height at scale 1.0 as a fraction of the surface's short side (orientation-invariant). Hardcoded identically in
 *  SubtitleOverlay.java and SubtitleOverlayView.swift: retune the three together. */
export const SUBTITLE_HEIGHT_FRACTION = 0.035;

/** Same ladder for DOM cues, one notch lower: the browser path is read from a desktop monitor; TVs default to `large`. */
export const DOM_SUBTITLE_HEIGHT_FRACTION = 0.03;

/** Floor under the fraction in CSS px / dp / pt, scaled by the preset; repeated in the native renderers (MIN_TEXT_SIZE_SP, minPointSize). */
export const SUBTITLE_MIN_TEXT_PX = 18;

/** Shifts the ladder up one notch on webOS (reads smaller than other TV paths); only the DOM overlay honours it. */
export const WEBOS_CUE_SIZE_BOOST = 1.3;

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

/** Background colour as Android-format ARGB hex (`#AARRGGBB`); `cast.service` re-orders to `#RRGGBBAA` for the receiver. */
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

/** The player's subtitle preset keys, as it hands them to an engine. */
export interface SubtitleStyleSettings {
  size: string;
  color: string;
  shadow: string;
  background: string;
  bottomMargin: number;
  topMargin?: number;
}

/** The style payload the ExoPlayer/AVPlayer plugins and mpv all take. */
export interface NativeSubtitleStyle {
  fontScale: number;
  foregroundColor: string;
  backgroundColor: string;
  edgeType: string;
  bottomMarginPercent: number;
  topMarginPercent?: number;
}

export function toNativeSubtitleStyle(settings: SubtitleStyleSettings): NativeSubtitleStyle {
  return {
    fontScale: NATIVE_SUBTITLE_SIZE_SCALE[settings.size] ?? 1.0,
    foregroundColor: SUBTITLE_FG_HEX[settings.color] ?? '#FFFFFF',
    backgroundColor: SUBTITLE_BG_ARGB[settings.background] ?? 'transparent',
    edgeType: SUBTITLE_EDGE_KEY[settings.shadow] ?? 'drop_shadow',
    bottomMarginPercent: settings.bottomMargin,
    topMarginPercent: settings.topMargin,
  };
}
