import type { DesktopSubtitleStyle } from '../../shared/contract';

// Base subtitle size the app's fontScale presets multiply. mpv's own default
// (55) renders far too large, so we calibrate lower — at scale 1.0 this lands
// around a typical caption height once mpv scales it to the window.
export const MPV_BASE_SUB_FONT_SIZE = 30;

/** Translate the app's subtitle style presets to mpv `sub-*` property pairs.
 *  Shared by every playback backend (the Linux compositor and the embed
 *  subprocess) so subtitles render identically — same font scale, colours and
 *  edge effect — regardless of platform.
 *
 *  Both the app and mpv use #AARRGGBB with 00 = transparent / FF = opaque, so
 *  colours pass through unchanged. `sub-ass-override=force` lets the app style
 *  win over a subtitle track's embedded ASS/SSA styling, matching the mobile
 *  native player. `background-box` draws the configured backdrop behind the
 *  text; with no backdrop we fall back to outline-and-shadow so the edge effect
 *  is what's visible. Property values are strings so they suit both libmpv's
 *  setProperty and the subprocess JSON-IPC set_property. */
export function mpvSubtitleProps(s: DesktopSubtitleStyle): Array<[string, string]> {
  const hasBox = !!s.backgroundColor && s.backgroundColor !== 'transparent';
  const props: Array<[string, string]> = [
    ['sub-ass-override', 'force'],
    ['sub-font-size', String(Math.round(MPV_BASE_SUB_FONT_SIZE * (s.fontScale || 1)))],
    ['sub-color', s.foregroundColor || '#FFFFFF'],
    ['sub-border-style', hasBox ? 'background-box' : 'outline-and-shadow'],
    ['sub-back-color', hasBox ? s.backgroundColor : '#00000000'],
    ['sub-pos', String(Math.max(0, Math.min(100, 100 - (s.bottomMarginPercent || 0))))],
  ];
  // Every branch sets outline-size / shadow-offset / blur explicitly: these are
  // sticky mpv properties, so a preset that omits one would inherit a stale
  // value from the previous preset.
  switch (s.edgeType) {
    case 'none':
      props.push(['sub-outline-size', '0'], ['sub-shadow-offset', '0'], ['sub-blur', '0']);
      break;
    case 'outline':
      props.push(
        ['sub-outline-size', '3'], ['sub-outline-color', '#FF000000'],
        ['sub-shadow-offset', '0'], ['sub-blur', '0'],
      );
      break;
    case 'raised':
      props.push(
        ['sub-outline-size', '1'], ['sub-outline-color', '#FF000000'],
        ['sub-shadow-offset', '1'], ['sub-shadow-color', '#FF000000'], ['sub-blur', '0'],
      );
      break;
    case 'drop_shadow':
    default:
      // A soft glow behind the text with NO directional offset — a blurred,
      // half-opacity black outline. The blur lands on the outline (not the
      // fill), so the glyphs stay crisp; the offset is zero, so there's no
      // displaced ghost copy. Opacity is kept low so it reads as a light shadow
      // rather than a dark band around the text.
      props.push(
        ['sub-outline-size', '1.5'], ['sub-outline-color', '#4D000000'],
        ['sub-shadow-offset', '0'], ['sub-shadow-color', '#00000000'], ['sub-blur', '0.5'],
      );
      break;
  }
  return props;
}
