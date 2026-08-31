/**
 * Run the TV downlevel pipeline over a Tailwind-emitted stylesheet.
 *
 * Tizen 6.5 / webOS 6 ship Chromium ~85, which predates:
 *  - cascade layers (Chrome 99)
 *  - `:is()` / `:where()` (88)
 *  - `:has()` (105)
 *  - `:focus-visible` (86)
 *  - logical properties / `inset:` shorthand (87)
 *  - `oklch()` / `oklab()` / `color-mix()` (111)
 *  - container queries / `cq*` units (105)
 *  - `@starting-style` (117)
 *  - `text-wrap: balance` (114)
 *
 * Any unrecognised token discards the surrounding declaration or rule,
 * which on Tailwind v4 + daisyUI cascades into "no CSS at all". The
 * pipeline below produces a fallback variant alongside the modern syntax
 * for properties that can be polyfilled, and strips the rest.
 *
 * Pipeline order matters — see comments inline.
 */
import postcss from 'postcss';
import presetEnv from 'postcss-preset-env';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '..');
const require = createRequire(import.meta.url);

const unwrapLayers = require(resolve(clientRoot, 'postcss/unwrap-layers.cjs'));
const stripUnsupportedSelectors = require(resolve(clientRoot, 'postcss/strip-unsupported-selectors.cjs'));
const tvFallbacks = require(resolve(clientRoot, 'postcss/tv-fallbacks.cjs'));
const tvColorMixAlpha = require(resolve(clientRoot, 'postcss/tv-color-mix-alpha.cjs'));

const processor = postcss([
  // preset-env handles the bulk: cascade-layer ordering via specificity
  // hacks, `:is(A,B)` → `A, B`, logical → physical properties,
  // `:focus-visible` → `:focus`, oklab/color-mix rgb fallbacks, modern
  // hex notation, etc. `preserve` is true on color features so modern
  // browsers reading the same bytes (rare on TV, but cheap) still pick
  // up the wide-gamut original.
  presetEnv({
    stage: 2,
    browsers: 'chrome 85',
    preserve: false,
    features: {
      'cascade-layers': true,
      'is-pseudo-class': { preserve: false },
      'logical-properties-and-values': true,
      // Disabled — preset-env always emits the `.focus-visible.js-focus-visible`
      // class-based form even with `replaceWith: ':focus'`, and we don't ship
      // the WICG focus-visible.js polyfill that sets that class. Handled
      // instead in `tv-fallbacks.cjs` with a literal `:focus-visible` → `:focus`
      // rewrite that doesn't depend on a runtime polyfill. On TV every
      // focus is keyboard focus anyway, so the semantic is preserved.
      'focus-visible-pseudo-class': false,
      'oklab-function': { preserve: true, subFeatures: { displayP3: false } },
      'color-mix': { preserve: true },
      'color-functional-notation': true,
      'hexadecimal-alpha-notation': true,
    },
  }),
  // After preset-env, any leftover `@layer` wrappers (preset-env keeps
  // them when `cascade-layers.preserve` defaults to true at certain
  // stages) must go — Chromium 85 ignores `@layer` and drops the body.
  unwrapLayers(),
  // Splits selector lists and drops branches that reference pseudos
  // unknown to Chromium 85 (`:has`, `:focus-visible`,
  // `::file-selector-button`, `::marker`, …). Strict pre-Selectors-L4
  // parsing on the TV would invalidate the whole rule on a single
  // unknown token; keeping only the surviving siblings (e.g. plain
  // `button` from `button, …, ::file-selector-button`) restores the
  // Tailwind preflight resets that the WebView would otherwise discard.
  stripUnsupportedSelectors(),
  // Final pass: unwrap `:where()`, flatten `@container`, drop
  // `@starting-style`, `text-wrap`, and `cq*`-unit declarations.
  tvFallbacks(),
  // Rebuild the alpha on Tailwind's `/NN` colour variants. Last, and after
  // preset-env, which is what leaves the `rgb()` theme values it reads.
  tvColorMixAlpha(),
]);

export const downlevelCss = async (css, from) => {
  const result = await processor.process(css, { from, to: from, map: false });
  return result.css;
};
