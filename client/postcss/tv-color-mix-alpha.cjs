/**
 * Restore the alpha on Tailwind's `/NN` colour variants for the TV WebView.
 *
 * `bg-base-content/5` compiles to `color-mix(in oklab, var(--color-base-content)
 * 5%, transparent)`. preset-env cannot resolve through the `var()`, so the
 * fallback it emits is the bare colour: the alpha is dropped and the TV paints
 * at 100 % — solid skeleton blocks, opaque `.divider` bars, black scrims, every
 * `text-base-content/NN` at full contrast.
 *
 * For each (colour, alpha) pair the stylesheet actually uses, declare a
 * pre-composed `--color-X-aNN: rgba(r, g, b, .NN)` in every theme block that
 * gives `--color-X` a literal value, then rewrite the mix to `var(--color-X-aNN)`.
 *
 * The alpha is folded in at build time on purpose. Substituting a var that holds
 * a COMPLETE value is the most basic form of custom-property support there is;
 * expanding one into several function arguments (`rgba(var(--x-rgb), .1)`) is
 * not, and that form did not hold up on the TV. Declaring the pairs per theme
 * block keeps the cascade intact — a light and a dark theme resolve their own.
 *
 * Must run after preset-env, which is what turns the themes' `oklch()` values
 * into the `rgb()` ones this reads. Mixing an opaque colour with `transparent`
 * is that colour at N% alpha, so the rewrite is exact, not an approximation.
 *
 * Left alone: literal mixes (`color-mix(in srgb, #fff 20%, transparent)`), which
 * preset-env already resolves, and anything this cannot express exactly —
 * `currentColor`, or a second colour that is not transparent.
 *
 * Rewriting is only half the job. daisyUI and preset-env both keep the alpha'd
 * value behind `@supports (color: color-mix(…))`, with the OPAQUE colour as the
 * fallback outside it — so on a WebView without color-mix the rewrite would land
 * in a block that is never evaluated and the opaque fallback would still win
 * (`.divider` was a solid bar, not a hairline). Those queries are flattened at
 * the end: nothing inside them needs color-mix support any more, and a
 * declaration that still does is dropped at parse time exactly as before.
 */
const CHANNELS =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*(?:1|1?\.0+|100%)\s*)?\)$/;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `[r, g, b]` for a colour Chromium can already parse, else null. */
function toChannels(value) {
  const v = value.trim();
  const m = CHANNELS.exec(v);
  if (m) return [m[1], m[2], m[3]];
  const h = HEX.exec(v);
  if (!h) return null;
  const hex =
    h[1].length === 3
      ? h[1]
          .split('')
          .map((c) => c + c)
          .join('')
      : h[1];
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const MIX =
  /color-mix\(\s*(?:in\s+[\w-]+\s*,\s*)?var\(\s*(--color-[\w-]+)\s*\)\s+([\d.]+)%\s*,\s*(?:transparent|#0000|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))\s*\)/gi;

/** `12.5` → `12_5`, so the generated property name stays a valid ident. */
const alphaSuffix = (pct) => String(pct).replace('.', '_');

module.exports = () => ({
  postcssPlugin: 'tv-color-mix-alpha',
  // OnceExit, not Once: PostCSS interleaves plugin visitors, so the `rgb()`
  // theme fallbacks this reads only exist once preset-env has finished.
  OnceExit: (root) => {
    // Which alphas each colour is actually asked for, so only those are emitted.
    const alphas = new Map();
    root.walkDecls((decl) => {
      if (!decl.value.includes('color-mix(')) return;
      for (const [, name, pct] of decl.value.matchAll(MIX)) {
        if (!alphas.has(name)) alphas.set(name, new Set());
        alphas.get(name).add(pct);
      }
    });
    if (alphas.size === 0) return;

    // One pre-composed colour per theme block, so the cascade still decides.
    const emitted = new Set();
    root.walkDecls(/^--color-/, (decl) => {
      const wanted = alphas.get(decl.prop);
      if (!wanted) return;
      const channels = toChannels(decl.value);
      if (!channels) return;
      const [r, g, b] = channels;
      for (const pct of wanted) {
        const prop = `${decl.prop}-a${alphaSuffix(pct)}`;
        const alpha = +(Number(pct) / 100).toFixed(4);
        decl.cloneAfter({ prop, value: `rgba(${r}, ${g}, ${b}, ${alpha})` });
        emitted.add(prop);
      }
    });

    root.walkDecls((decl) => {
      if (!decl.value.includes('color-mix(')) return;
      decl.value = decl.value.replace(MIX, (whole, name, pct) => {
        const prop = `${name}-a${alphaSuffix(pct)}`;
        return emitted.has(prop) ? `var(${prop})` : whole;
      });
    });

    root.walkAtRules('supports', (atRule) => {
      if (!atRule.params.includes('color-mix(')) return;
      // A query that also demands oklab/oklch gates wide-gamut values this
      // WebView cannot use either way — leave those gated.
      if (/okla[bc]\(|oklch\(/.test(atRule.params)) return;
      // Only flatten a block this pass fully rewrote. A leftover mix would be
      // exposed rather than skipped, and a custom property is never invalid at
      // parse time — it substitutes garbage into whatever reads it, which then
      // falls back to its initial value (daisyUI's `--btn-border` did exactly
      // that, painting a currentColor ring around every focused button).
      let unrewritten = false;
      atRule.walkDecls((d) => {
        if (d.value.includes('color-mix(')) unrewritten = true;
      });
      if (unrewritten) return;
      if (atRule.nodes) atRule.replaceWith(atRule.nodes);
      else atRule.remove();
    });
  },
});
module.exports.postcss = true;
