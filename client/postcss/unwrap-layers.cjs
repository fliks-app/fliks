/**
 * Flatten every `@layer NAME { ... }` block into its inner rules, and drop
 * layer-order declarations like `@layer a, b, c;`. Needed for TV WebViews
 * (Tizen 6.5 / webOS 6) whose Chromium predates `@layer` (added in 99); the
 * native parser discards every layer block, taking the whole stylesheet
 * with it. This pass runs after `@csstools/postcss-cascade-layers` has
 * already encoded the cascade order via `:not(#\#)` specificity hacks, so
 * removing the wrappers preserves the intended ordering.
 */
module.exports = () => ({
  postcssPlugin: 'unwrap-layers',
  AtRule: {
    layer: (atRule) => {
      if (atRule.nodes) atRule.replaceWith(atRule.nodes);
      else atRule.remove();
    },
  },
});
module.exports.postcss = true;
