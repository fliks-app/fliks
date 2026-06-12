/**
 * TV-only downlevel pass. Runs after `postcss-preset-env`, `unwrap-layers`
 * and `strip-has`. Handles the features `preset-env` can't polyfill so a
 * single unsupported token doesn't invalidate the surrounding rule on
 * Tizen 6.5 / webOS 6 WebViews (Chromium ~85).
 *
 *   - `:where(X)`            → X (preset-env converts `:is` but leaves
 *                                `:where`; the zero-specificity wrapper is
 *                                fine to drop because we don't rely on it
 *                                for cascade ordering at runtime).
 *   - `@container (…) { … }` → flatten to the inner rules (we render at a
 *                                fixed 1080p viewport — close enough for
 *                                the TV bundle).
 *   - `@starting-style { … }`→ remove entirely (entry animation, optional).
 *   - `text-wrap: balance|pretty`, `field-sizing: …`              → drop.
 *   - viewport-only container units (`cqi`/`cqw`/`cqh`/`cqb`)     → drop
 *     declarations that use them — `width:95cqi` would parse to an invalid
 *     length and the whole declaration is discarded anyway; removing it
 *     keeps a cleaner stylesheet.
 */
const splitTopLevelCommas = (selector) => {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts.map((s) => s.trim()).filter(Boolean);
};

/**
 * Replace `:where(X)` / `:is(X)` with X in-place at the first match,
 * iterating until none remain. Multi-branch forms (`:where(A,B)`) get
 * dropped down to the first branch on this single-selector pass; the
 * caller handles fan-out across the rule's comma list separately.
 */
const unwrapPseudo = (selector, name) => {
  const needle = `:${name}(`;
  let out = selector;
  while (true) {
    const idx = out.indexOf(needle);
    if (idx === -1) return out;
    let depth = 1;
    let j = idx + needle.length;
    while (j < out.length && depth > 0) {
      const c = out[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      j++;
    }
    if (depth !== 0) return out;
    const inner = out.slice(idx + needle.length, j - 1);
    const first = splitTopLevelCommas(inner)[0] ?? '';
    out = out.slice(0, idx) + first + out.slice(j);
  }
};

/** Walk `:not(...)` occurrences in a selector and drop the ones whose
 *  arg is too complex for Chromium 85's Level-3 parser. Allowed inside
 *  `:not(...)`: a SINGLE simple selector — one tag/class/id/attribute/
 *  pseudo (no combinators, no compound pseudos, no nested pseudo with
 *  args).
 *  Examples kept: `:not(.foo)`, `:not(:hover)`, `:not([disabled])`.
 *  Examples dropped: `:not(:active:focus)` (compound),
 *  `:not(input:checked:not(.x .y))` (complex + nested),
 *  `:not(.a, .b)` (multi-arg). */
function stripUnsupportedNot(selector) {
  let out = '';
  let i = 0;
  while (i < selector.length) {
    const j = selector.indexOf(':not(', i);
    if (j === -1) {
      out += selector.slice(i);
      break;
    }
    out += selector.slice(i, j);
    // Find matching close paren
    let depth = 1;
    let k = j + 5;
    while (k < selector.length && depth > 0) {
      const c = selector[k];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      k++;
    }
    if (depth !== 0) {
      out += selector.slice(j);
      break;
    }
    const inner = selector.slice(j + 5, k - 1);
    if (isLevel3SimpleSelector(inner)) {
      out += ':not(' + inner + ')';
    }
    // Otherwise drop this `:not(...)` entirely.
    i = k;
  }
  return out;
}

function isLevel3SimpleSelector(s) {
  s = s.trim();
  if (!s) return false;
  // Reject combinators, commas (multi-arg), parens (nested pseudo with args).
  if (/[\s>+~,]/.test(s)) return false;
  if (/\(/.test(s)) return false;
  // Allow only ONE simple selector token. A simple selector is:
  //   .class | #id | tag | [attr] | :pseudo
  // Compound (e.g. `:active:focus`, `input:checked`) has multiple
  // tokens — reject those.
  // Split on the start of each simple token.
  const tokens = s.match(/(^[a-zA-Z][\w-]*)|(\.[\w-]+)|(#[\w-]+)|(\[[^\]]+\])|(:[\w-]+)/g);
  if (!tokens) return false;
  // Rejoin and compare — if any chars left over, complex.
  return tokens.join('') === s && tokens.length === 1;
}

/** `translate: x [y]` (Chrome 104+) → an equivalent transform function for
 *  Chromium 85, which drops the standalone property. */
function translateToFn(value) {
  const parts = value.trim().split(/\s+/);
  if (parts.length <= 1) return `translateX(${parts[0] || '0'})`;
  return `translate(${parts[0]}, ${parts[1]})`;
}

/** `scale: x [y]` → `scale(...)`, converting the percentage form (`95%` → `.95`)
 *  the `scale()` function doesn't accept. */
function scaleToFn(value) {
  const toNum = (v) => (v.endsWith('%') ? String(parseFloat(v) / 100) : v);
  const parts = value.trim().split(/\s+/).map(toNum);
  return parts.length <= 1 ? `scale(${parts[0]})` : `scale(${parts[0]}, ${parts[1]})`;
}

const CQ_UNIT = /\d(cqi|cqw|cqh|cqb)\b/;
const DROP_PROPS = new Set(['text-wrap', 'field-sizing']);
const SCROLL_INLINE_MAP = {
  'scroll-padding-inline': ['scroll-padding-left', 'scroll-padding-right'],
  'scroll-margin-inline': ['scroll-margin-left', 'scroll-margin-right'],
};

module.exports = () => ({
  postcssPlugin: 'tv-fallbacks',
  Rule: (rule) => {
    // `:focus-visible` → `:focus`. On TV every focus is keyboard focus
    // (D-pad, remote arrow keys), so the user-agent distinction the
    // pseudo encodes doesn't apply. preset-env's class-based polyfill
    // needs the WICG focus-visible.js shim at runtime, which we don't
    // ship — without the rewrite the focused list item has no outline.
    if (rule.selector.includes(':focus-visible')) {
      rule.selector = rule.selector.replace(/:focus-visible\b/g, ':focus');
    }
    // Drop `:not()` arguments Chromium 85 can't parse — only Level 3
    // (single simple selector). Compound (`:not(:active:focus)`) and
    // complex (`:not(input:checked:not(.filter .btn))`) args invalidate
    // the entire rule under strict parsing, which kills daisyUI's
    // `.btn-ghost:not(…,:active:focus,…,input:checked:not(…)){--btn-bg:
    // transparent}` and the ghost buttons fall back to the gray default.
    // Dropping the unsupported `:not()` arms widens the rule a touch
    // (it may match a few states it shouldn't on TV) but keeps the
    // transparent bg intact, which is the load-bearing part.
    if (rule.selector.includes(':not(')) {
      rule.selector = stripUnsupportedNot(rule.selector);
    }
    if (rule.selector.includes(':where(') || rule.selector.includes(':is(')) {
      const next = splitTopLevelCommas(rule.selector)
        .map((s) => unwrapPseudo(unwrapPseudo(s, 'where'), 'is'))
        .filter(Boolean);
      if (next.length === 0) rule.remove();
      else rule.selector = next.join(',');
    }
    // Tailwind v4 emits the individual transform properties `translate` /
    // `rotate` / `scale` (Chrome 104+); Chromium 85 silently drops them, so
    // centering, hover-scale, indicators etc. break. Fold whatever a rule
    // carries into ONE `transform` — in spec order (translate → rotate →
    // scale) so several on one rule compose instead of clobbering, and so a
    // `transition: translate` (rewritten below) still animates it.
    let tx = null;
    let rot = null;
    let sc = null;
    rule.walkDecls((d) => {
      if (d.prop === 'translate') tx = translateToFn(d.value);
      else if (d.prop === 'rotate') rot = `rotate(${d.value})`;
      else if (d.prop === 'scale') sc = scaleToFn(d.value);
    });
    if (tx || rot || sc) {
      rule.walkDecls((d) => {
        if (d.prop === 'translate' || d.prop === 'rotate' || d.prop === 'scale') {
          d.remove();
        }
      });
      const composed = [tx, rot, sc].filter(Boolean).join(' ');
      const existing = rule.nodes.find(
        (n) => n.type === 'decl' && n.prop === 'transform',
      );
      if (existing) existing.value = `${composed} ${existing.value}`;
      else rule.append({ prop: 'transform', value: composed });
    }
  },
  AtRule: {
    container: (atRule) => {
      if (atRule.nodes) atRule.replaceWith(atRule.nodes);
      else atRule.remove();
    },
    'starting-style': (atRule) => atRule.remove(),
  },
  Declaration: (decl) => {
    if (DROP_PROPS.has(decl.prop)) {
      decl.remove();
      return;
    }
    // The transform-property → `transform` rewrite (Rule handler) leaves any
    // `transition: translate …` animating a property that no longer exists —
    // point it at `transform` instead.
    if (
      (decl.prop === 'transition' || decl.prop === 'transition-property') &&
      /\b(?:translate|rotate|scale)\b/.test(decl.value)
    ) {
      decl.value = decl.value.replace(/\b(?:translate|rotate|scale)\b/g, 'transform');
    }
    const inlineMap = SCROLL_INLINE_MAP[decl.prop];
    if (inlineMap) {
      for (const physical of inlineMap) decl.cloneBefore({ prop: physical });
      decl.remove();
      return;
    }
    // Strip CSS Color Module 4 interpolation hints (`in oklab`, `in oklch`,
    // `in lab`, `in lch`). They appear inside `linear-gradient(…)` and
    // `color-mix(…)` to tell the browser which colour space to blend in.
    // Chromium 85 doesn't recognise the keyword and invalidates the
    // whole declaration (the gradient disappears, the player controls
    // backdrop becomes "none" and the icons read as floating glyphs on
    // top of the video). Stripping the hint downgrades to srgb
    // interpolation, which is perceptually slightly off but visually
    // fine for UI backdrops.
    if (/ in (oklab|oklch|lab|lch|srgb-linear)\b/.test(decl.value)) {
      decl.value = decl.value.replace(/\s+in (oklab|oklch|lab|lch|srgb-linear)\b\s*,?/g, '');
    }
    if (CQ_UNIT.test(decl.value)) decl.remove();
  },
});
module.exports.postcss = true;
