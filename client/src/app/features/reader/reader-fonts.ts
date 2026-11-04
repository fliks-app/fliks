const face = (family: string, file: string, weight: string, style: string): string =>
  `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};font-display:swap;` +
  `src:url("${new URL(`reader-fonts/${file}.woff2`, document.baseURI).href}") format("woff2")}`;

/** The two self-hosted reading faces; a book frame is a blob document and cannot see the app's own CSS. */
export const readerFontCss = (): string =>
  [
    face('Literata Variable', 'literata-latin-wght-normal', '200 900', 'normal'),
    face('Literata Variable', 'literata-latin-wght-italic', '200 900', 'italic'),
    face('Atkinson Hyperlegible', 'atkinson-hyperlegible-latin-400-normal', '400', 'normal'),
    face('Atkinson Hyperlegible', 'atkinson-hyperlegible-latin-400-italic', '400', 'italic'),
    face('Atkinson Hyperlegible', 'atkinson-hyperlegible-latin-700-normal', '700', 'normal'),
    face('Atkinson Hyperlegible', 'atkinson-hyperlegible-latin-700-italic', '700', 'italic'),
  ].join('');

const STYLE_ID = 'fliks-reader-fonts';

/** Idempotent: a frame or the app document gets the faces once. */
export function provideReaderFonts(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = readerFontCss();
  doc.head.appendChild(style);
}
