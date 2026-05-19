/**
 * Drop branches of a comma-separated selector list that reference
 * pseudo-classes / pseudo-elements unknown to the Tizen 6.5 / webOS 6
 * Chromium (~85). Strict pre-Selectors-L4 parsing invalidates the whole
 * rule if any branch contains an unknown token — so daisyUI's
 * `button, input, …, ::file-selector-button { background: transparent }`
 * silently drops, taking `button`'s reset with it.
 *
 * Each unsupported token is matched as a literal substring inside a
 * single branch. Branches without unknowns are kept verbatim; if every
 * branch is unsupported the rule is removed.
 *
 * Note: this only handles flat comma lists. Nested forms like
 * `:is(:has(…), …)` should already be neutralised upstream by
 * `unwrap-layers`, `tv-fallbacks` (`:where`/`:is` unwrap) and
 * preset-env's `is-pseudo-class`. Anything that still slips through
 * lands here as a last line of defence.
 */
const UNSUPPORTED_TOKENS = [
  ':has(',                  // Chrome 105
  ':focus-visible',         // Chrome 86 — preset-env polyfills the
                            //   `.focus-visible` class fallback, so the
                            //   `:focus-visible` branch is safe to drop.
  ':user-invalid',          // Chrome 119
  ':user-valid',            // Chrome 119
  ':dir(',                  // Chrome 89
  '::file-selector-button', // Chrome 89
  '::marker',               // Chrome 86
  '::backdrop',             // safe — but only as flat pseudo on <dialog>;
                            //   not stripped to avoid removing legitimate
                            //   modal backdrop rules. Listed here for
                            //   visibility — kept enabled below if needed.
  '::picker(',              // Chrome 130
  '::details-content',      // Chrome 131
  ':modal',                 // Chrome 105
  ':popover-open',          // Chrome 114
  ':state(',                // Chrome 125
];

// Tokens that we definitively strip. Excluded:
//   - `::backdrop` (Chrome 37 — always supported)
//   - `:focus-visible` is handled by `tv-fallbacks.cjs`, which rewrites it
//     to `:focus` globally (also inside `:not(...)`). Listing it here
//     would drop entire daisyUI rules like `.btn-ghost:not(...,:focus-
//     visible,...)`, killing `--btn-bg: #0000` and turning every ghost
//     button opaque.
const STRIP_TOKENS = UNSUPPORTED_TOKENS.filter(
  (t) => t !== '::backdrop' && t !== ':focus-visible',
);

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

const branchIsUnsupported = (branch) => STRIP_TOKENS.some((tok) => branch.includes(tok));

module.exports = () => ({
  postcssPlugin: 'strip-unsupported-selectors',
  Rule: (rule) => {
    if (!STRIP_TOKENS.some((tok) => rule.selector.includes(tok))) return;
    const kept = splitTopLevelCommas(rule.selector).filter((s) => !branchIsUnsupported(s));
    if (kept.length === 0) rule.remove();
    else rule.selector = kept.join(',');
  },
});
module.exports.postcss = true;
