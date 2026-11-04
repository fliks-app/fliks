const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const SUBSETS = [
  ['latin', LATIN],
  ['latin-ext', LATIN_EXT],
] as const;

/** The directory of the self-hosted faces, which a book frame's CSP has to let in by name. */
export const readerFontsDir = (): string => new URL('reader-fonts/', document.baseURI).href;

const face = (family: string, file: string, weight: string, style: string, range: string): string =>
  `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};font-display:swap;` +
  `src:url("${readerFontsDir()}${file}.woff2") format("woff2");unicode-range:${range}}`;

/** The two self-hosted reading faces, each in its latin and latin-ext subset; a book frame is a blob document and cannot see the app's own CSS. */
export const readerFontCss = (): string =>
  SUBSETS.flatMap(([subset, range]) => [
    ...(['normal', 'italic'] as const).map((style) =>
      face('Literata Variable', `literata-${subset}-wght-${style}`, '200 900', style, range),
    ),
    ...(['400', '700'] as const).flatMap((weight) =>
      (['normal', 'italic'] as const).map((style) =>
        face('Atkinson Hyperlegible', `atkinson-hyperlegible-${subset}-${weight}-${style}`, weight, style, range),
      ),
    ),
  ]).join('');

const STYLE_ID = 'fliks-reader-fonts';

/** Idempotent: a frame or the app document gets the faces once. */
export function provideReaderFonts(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = readerFontCss();
  doc.head.appendChild(style);
}
