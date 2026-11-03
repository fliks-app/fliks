import {
  buildSpreads,
  clampPan,
  drawOrder,
  pageWidth,
  preloadScreens,
  reportedPage,
  spreadIndexOf,
  stepToward,
  widthBucket,
  zoomAt,
} from './comic-layout';

const portrait = { width: 800, height: 1200 };
const landscape = { width: 1600, height: 1000 };
const book = (n: number) => Array.from({ length: n }, () => portrait);

describe('comic-layout', () => {
  it('shows one page per screen unless spreads are on', () => {
    expect(buildSpreads(book(3), false)).toEqual([[1], [2], [3]]);
  });

  it('keeps the cover alone and pairs the rest, the odd last page alone', () => {
    expect(buildSpreads(book(6), true)).toEqual([[1], [2, 3], [4, 5], [6]]);
  });

  it('leaves a landscape page alone and pairs again after it', () => {
    const pages = [portrait, portrait, landscape, portrait, portrait, portrait];
    expect(buildSpreads(pages, true)).toEqual([[1], [2], [3], [4, 5], [6]]);
  });

  it('finds the screen of a page and reports the last page of a spread', () => {
    const s = buildSpreads(book(6), true);
    expect(spreadIndexOf(s, 5)).toBe(2);
    expect(spreadIndexOf(s, 99)).toBe(0);
    expect(reportedPage([4, 5])).toBe(5);
  });

  it('draws a right-to-left spread with the first page on the right', () => {
    expect(drawOrder([2, 3], true)).toEqual([3, 2]);
    expect(drawOrder([2, 3], false)).toEqual([2, 3]);
  });

  it('turns toward the tapped side, reversed in right-to-left', () => {
    expect(stepToward('right', false)).toBe(1);
    expect(stepToward('left', false)).toBe(-1);
    expect(stepToward('left', true)).toBe(1);
    expect(stepToward('right', true)).toBe(-1);
  });

  it('preloads the next two screens then the previous one, within the book', () => {
    const s = buildSpreads(book(6), true);
    expect(preloadScreens(s, 1)).toEqual([2, 3, 0]);
    expect(preloadScreens(s, 3)).toEqual([2]);
    expect(preloadScreens(s, 0)).toEqual([1, 2]);
  });

  it('buckets the width to a step, within bounds', () => {
    expect(widthBucket(390, 3)).toBe(1280);
    expect(widthBucket(100, 1)).toBe(512);
    expect(widthBucket(5000, 3)).toBe(3072);
    expect(widthBucket(1000, 1)).toBe(1024);
    expect(pageWidth(portrait, { w: 1000, h: 4000 }, 2, 1)).toBe(512);
    expect(pageWidth(portrait, { w: 1000, h: 600 }, 1, 1)).toBe(512);
    expect(pageWidth(portrait, { w: 1000, h: 600 }, 1, 1, 2)).toBe(1024);
  });

  it('keeps a zoomed page covering the viewport', () => {
    const view = { w: 400, h: 600 };
    expect(clampPan({ x: 999, y: -999 }, 2, view)).toEqual({ x: 200, y: -300 });
    expect(clampPan({ x: 50, y: 50 }, 1, view)).toEqual({ x: 0, y: 0 });
  });

  it('zooms around the anchor and caps the scale', () => {
    const view = { w: 400, h: 600 };
    const r = zoomAt({ x: 0, y: 0 }, 1, 2, { x: 100, y: 0 }, view);
    expect(r.scale).toBe(2);
    expect(r.pan.x).toBe(-100);
    expect(zoomAt({ x: 0, y: 0 }, 1, 99, { x: 0, y: 0 }, view).scale).toBe(4);
  });
});
