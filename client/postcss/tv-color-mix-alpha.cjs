/**
 * Restore the alpha on Tailwind's `/NN` colour variants for Chromium 85.
 *
 * `bg-base-300/40` compiles to `color-mix(in oklab, var(--color-base-300) 40%,
 * transparent)`. preset-env cannot resolve through the `var()`, so the fallback
 * it emits is the bare colour: the alpha is dropped and the TV paints at 100 %
 * — solid skeleton blocks, opaque `.divider` bars, black instead of dimmed
 * scrims, every `text-base-content/50` at full contrast.
 *
 * Emit a `--color-X-rgb: r, g, b` companion beside each literal `--color-X` and
 * rewrite the mix to `rgba(var(--color-X-rgb), .4)`, which Chromium 85 parses.
 * Must run after preset-env, which is what turns the themes' `oklch()` values
 * into the `rgb()` ones this reads. Mixing an opaque colour with `transparent`
 * is just that colour at N% alpha, so the rewrite is exact, not an approximation.
 *
 * Literal mixes (`color-mix(in srgb, #fff 20%, transparent)`) already get a
 * computed fallback from preset-env and are left alone, as is any mix this
 * can't express: `currentColor`, or a second colour that isn't transparent.
 */
const CHANNELS =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*(?:1|1?\.0+|100%)\s*)?\)$/;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `r, g, b` for a colour Chromium 85 can already parse, else null. */
function toChannels(value) {
  const v = value.trim();
  const m = CHANNELS.exec(v);
  if (m) return `${m[1]}, ${m[2]}, ${m[3]}`;
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
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

const MIX =
  /color-mix\(\s*(?:in\s+[\w-]+\s*,\s*)?var\(\s*(--color-[\w-]+)\s*\)\s+([\d.]+)%\s*,\s*(?:transparent|#0000|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))\s*\)/gi;

module.exports = () => ({
  postcssPlugin: 'tv-color-mix-alpha',
  // OnceExit, not Once: PostCSS interleaves plugin visitors, so the `rgb()`
  // theme fallbacks this reads only exist once preset-env has finished.
  OnceExit: (root) => {
    // A companion per declaration, not one global set, so the `-rgb` var
    // follows whichever theme block wins the cascade.
    const known = new Set();
    root.walkDecls(/^--color-/, (decl) => {
      if (decl.prop.endsWith('-rgb')) return;
      const channels = toChannels(decl.value);
      if (!channels) return;
      known.add(decl.prop);
      decl.cloneAfter({ prop: `${decl.prop}-rgb`, value: channels });
    });
    if (known.size === 0) return;

    root.walkDecls((decl) => {
      if (!decl.value.includes('color-mix(')) return;
      decl.value = decl.value.replace(MIX, (whole, name, pct) =>
        known.has(name)
          ? `rgba(var(${name}-rgb), ${+(Number(pct) / 100).toFixed(4)})`
          : whole,
      );
    });
  },
});
module.exports.postcss = true;
