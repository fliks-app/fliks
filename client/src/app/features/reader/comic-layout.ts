import type { ComicPageSize } from '../../core/services/api/comics.models';

export type ComicMode = 'paged' | 'manga' | 'webtoon';
export const COMIC_MODES: readonly ComicMode[] = ['paged', 'manga', 'webtoon'];

/** Per volume: the reading direction and layout, and whether landscape-sized spreads pair two pages. */
export interface ComicPrefs {
  mode: ComicMode;
  spread: boolean;
}
export const COMIC_PREFS_DEFAULT: ComicPrefs = { mode: 'paged', spread: false };

export const WIDTH_STEP = 256;
export const WIDTH_MIN = 512;
export const WIDTH_MAX = 3072;
export const ZOOM_MAX = 4;

const isLandscape = (p: ComicPageSize | undefined): boolean => !!p && p.width > p.height;

/** Groups 1-based page numbers into what one screen shows, in reading order: the cover stands alone, a landscape page
 *  (already a spread) stands alone, the rest pair up. Without `spread` every page is its own screen. */
export function buildSpreads(pages: ComicPageSize[], spread: boolean): number[][] {
  const out: number[][] = [];
  for (let n = 1; n <= pages.length; n++) {
    const prev = out[out.length - 1];
    const pairable = spread && n > 2 && prev?.length === 1 && prev[0] === n - 1 && prev[0] > 1;
    if (pairable && !isLandscape(pages[n - 1]) && !isLandscape(pages[n - 2])) prev.push(n);
    else out.push([n]);
  }
  return out;
}

/** Index of the screen showing a page. */
export function spreadIndexOf(spreads: number[][], page: number): number {
  const i = spreads.findIndex((s) => s.includes(page));
  return i < 0 ? 0 : i;
}

/** Left to right as drawn: a right-to-left book puts the first page on the right. */
export function drawOrder(spread: number[], rtl: boolean): number[] {
  return rtl ? [...spread].reverse() : spread;
}

/** The page a screen reports: its last, so finishing the last screen reaches the last page. */
export function reportedPage(spread: number[]): number {
  return spread[spread.length - 1];
}

/** Screens to fetch ahead of (and just behind) the one shown, nearest first. */
export function preloadScreens(spreads: number[][], at: number): number[] {
  return [at + 1, at + 2, at - 1].filter((i) => i >= 0 && i < spreads.length);
}

/** Image width to ask for: the viewport in device pixels, rounded up to a step so a small resize keeps hitting the cache. */
export function widthBucket(cssPx: number, dpr: number): number {
  const px = Math.ceil(Math.max(1, cssPx) * Math.max(1, dpr));
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.ceil(px / WIDTH_STEP) * WIDTH_STEP));
}

/** Width to ask for a page shown with `count` pages across `view`: what fits, times a zoom tier. */
export function pageWidth(page: ComicPageSize, view: { w: number; h: number }, count: number, dpr: number, tier = 1): number {
  return widthBucket(Math.min(view.w / count, view.h * (page.width / page.height)) * tier, dpr);
}

/** Next/previous screen by physical side: in a right-to-left book the left side goes forward. */
export function stepToward(side: 'left' | 'right', rtl: boolean): 1 | -1 {
  return (side === 'right') !== rtl ? 1 : -1;
}

export interface Pan {
  x: number;
  y: number;
}

/** Keeps a zoomed page covering the viewport: the pan reaches the page's edges and no further. */
export function clampPan(pan: Pan, scale: number, view: { w: number; h: number }): Pan {
  const mx = (view.w * (scale - 1)) / 2;
  const my = (view.h * (scale - 1)) / 2;
  return { x: Math.min(mx, Math.max(-mx, pan.x)), y: Math.min(my, Math.max(-my, pan.y)) };
}

/** A new scale that leaves the point under `anchor` (from the viewport centre) where it is. */
export function zoomAt(pan: Pan, scale: number, next: number, anchor: Pan, view: { w: number; h: number }): { scale: number; pan: Pan } {
  const s = Math.min(ZOOM_MAX, Math.max(1, next));
  const k = s / scale;
  return { scale: s, pan: clampPan({ x: anchor.x - (anchor.x - pan.x) * k, y: anchor.y - (anchor.y - pan.y) * k }, s, view) };
}
