/* Receiver subtitles: the sender's TextTrackStyle as CSS for the receiver's own caption layer. */
(function (root) {
  'use strict';

  // CAF's own cue size, before the sender's fontScale.
  const BASE_FONT_VH = 4.1;
  const GENERIC = {
    SANS_SERIF: '"Droid Sans", sans-serif',
    MONOSPACED_SANS_SERIF: '"Droid Sans Mono", monospace',
    SERIF: '"Droid Serif", serif',
    MONOSPACED_SERIF: 'monospace',
    CASUAL: 'sans-serif',
    CURSIVE: 'cursive',
    SMALL_CAPITALS: 'sans-serif',
  };

  /** `#RRGGBB[AA]` as `{ css, alpha }`, null when unreadable. */
  function color(hex) {
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const alpha = m[2] ? Math.round((parseInt(m[2], 16) / 255) * 1000) / 1000 : 1;
    return { css: `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`, alpha };
  }

  function edgeShadow(type, edge) {
    const c = (color(edge) || color('#000000FF')).css;
    switch (type) {
      case 'OUTLINE':
        return `${c} -0.05em -0.05em 0, ${c} 0.05em -0.05em 0, ${c} -0.05em 0.05em 0, ${c} 0.05em 0.05em 0`;
      case 'DROP_SHADOW':
        return `${c} 0 0.06em 0.1em, ${c} 0 0.06em 0.14em`;
      case 'RAISED':
        return `${c} -0.04em -0.04em 0`;
      case 'DEPRESSED':
        return `${c} 0.04em 0.04em 0`;
      default:
        return 'none';
    }
  }

  function captionStyle(s) {
    const style = s || {};
    const scale = Number(style.fontScale) > 0 ? Number(style.fontScale) : 1;
    const bg = color(style.backgroundColor);
    const generic = GENERIC[style.fontGenericFamily] || GENERIC.SANS_SERIF;
    return {
      fontSize: Math.round(BASE_FONT_VH * scale * 100) / 100 + 'vh',
      fontFamily: (style.fontFamily ? `"${style.fontFamily}", ` : '') + generic,
      color: (color(style.foregroundColor) || color('#FFFFFFFF')).css,
      textShadow: edgeShadow(style.edgeType, style.edgeColor),
      // The window is left out, as CAF does: the iOS SDK's default style always sets one.
      background: bg && bg.alpha > 0 ? bg.css : 'transparent',
    };
  }

  const api = { captionStyle, BASE_FONT_VH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FliksCaptions = api;
})(typeof self !== 'undefined' ? self : this);
