import { EpubNavigator, FramePoolManager, type EpubNavigatorListeners, type IEpubPreferences } from '@readium/navigator';
import type { Locator, Publication } from '@readium/shared';
import { provideReaderFonts, readerFontsDir } from './reader-fonts';
import { destroyNavigator, sandboxContentFrames } from './frame-hardening';

/** Screens per reading-order resource, by href, for one layout. */
export type ScreenCounts = ReadonlyMap<string, number>;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Screens a laid-out chapter takes, or 0 while its columns are not set up yet. */
export function screensOf(wnd: Window): number {
  const doc = wnd.document;
  const el = doc.scrollingElement;
  // A blank or unstyled frame is one screen wide: only a frame with ReadiumCSS columns counts.
  if (doc.readyState !== 'complete' || !el || !wnd.innerWidth || !doc.documentElement.style.getPropertyValue('--USER__view')) return 0;
  return Math.max(1, Math.round(el.scrollWidth / wnd.innerWidth));
}

export const screenIndex = (progression: number, screens: number): number =>
  Math.round(clamp01(progression) * (screens - 1));

/** Pages of the book before `href`, null while a resource on the way is not counted. */
function pagesBefore(order: string[], counts: ScreenCounts, href: string): number | null {
  let sum = 0;
  for (const h of order) {
    if (h === href) return sum;
    const n = counts.get(h);
    if (!n) return null;
    sum += n;
  }
  return null;
}

export interface PageAt {
  page: number;
  /** Screens left in the chapter after this one. */
  left: number;
}

export function pageAt(order: string[], counts: ScreenCounts, href: string, progression: number): PageAt | null {
  const before = pagesBefore(order, counts, href);
  const n = counts.get(href);
  if (before === null || !n) return null;
  const i = screenIndex(progression, n);
  return { page: before + i + 1, left: n - i - 1 };
}

/** The book's page count, null until every resource is counted. */
export function pageCount(order: string[], counts: ScreenCounts): number | null {
  let sum = 0;
  for (const h of order) {
    const n = counts.get(h);
    if (!n) return null;
    sum += n;
  }
  return order.length ? sum : null;
}

/** Counts are valid for one layout and one frame size. */
export const layoutSignature = (settings: object, w: number, h: number): string =>
  JSON.stringify([settings, w, h]);

const cacheKey = (itemId: number): string => `reader.pages:${itemId}`;

export function loadCounts(itemId: number, signature: string): Map<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(cacheKey(itemId)) ?? 'null') as { sig?: string; counts?: Record<string, number> } | null;
    if (raw?.sig === signature && raw.counts) return new Map(Object.entries(raw.counts));
  } catch {
    // Storage blocked or corrupt: the book is paginated again.
  }
  return new Map();
}

export function saveCounts(itemId: number, signature: string, counts: ScreenCounts): void {
  try {
    localStorage.setItem(cacheKey(itemId), JSON.stringify({ sig: signature, counts: Object.fromEntries(counts) }));
  } catch {
    // Storage full or blocked.
  }
}

/** The window of a resource's pooled frame, laid out whether or not it is the one shown. */
export function frameWindow(nav: EpubNavigator, href: string): Window | null {
  const pool = nav.pool;
  return (pool instanceof FramePoolManager ? pool._frameFor(href)?.iframe.contentWindow : null) ?? null;
}

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const idle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Fonts and images shift the columns once they land, so a chapter is read after both settle. */
export async function settled(wnd: Window): Promise<void> {
  await frame();
  const images = [...wnd.document.images].filter((i) => !i.complete);
  const loads = images.map((i) => new Promise<void>((r) => { i.onload = i.onerror = () => r(); }));
  await Promise.race([Promise.all([wnd.document.fonts.ready, ...loads]), idle(2000)]);
  await frame();
}

export interface Pagination {
  host: HTMLElement;
  publication: Publication;
  positions: Locator[];
  prefs: IEpubPreferences;
  /** Resources already counted exactly by the reader's own frames. */
  skip: (href: string) => boolean;
  onCount: (href: string, screens: number) => void;
  aborted: () => boolean;
}

/** Lays every uncounted resource out in a hidden navigator of the reader's size and preferences, one at a time. */
export async function paginate(p: Pagination): Promise<void> {
  const box = p.host.getBoundingClientRect();
  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  container.inert = true;
  container.className = 'reader-host';
  container.style.cssText = `position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:${box.width}px;height:${box.height}px`;
  document.body.appendChild(container);
  const stopSandbox = sandboxContentFrames(container);
  const listeners: Partial<EpubNavigatorListeners> = { frameLoaded: (wnd) => provideReaderFonts(wnd.document) };
  const nav = new EpubNavigator(container, p.publication, listeners as EpubNavigatorListeners, p.positions, undefined, {
    preferences: p.prefs,
    defaults: {},
    keyboardPeripherals: [],
    upgradeInsecureRequests: 'auto',
    injectables: { rules: [], allowedDomains: [readerFontsDir()] },
  });
  try {
    await nav.load();
    for (const link of p.publication.readingOrder.items) {
      const href = link.href;
      if (p.aborted()) return;
      if (p.skip(href)) continue;
      const target = p.positions.find((l) => l.href === href);
      if (!target) continue;
      const ok = await new Promise<boolean>((r) => nav.go(target, false, r));
      const wnd = frameWindow(nav, href);
      if (!ok || !wnd) continue;
      provideReaderFonts(wnd.document);
      await settled(wnd);
      const n = screensOf(wnd);
      if (n && !p.aborted()) p.onCount(href, n);
      await idle(40);
    }
  } finally {
    stopSandbox();
    await destroyNavigator(nav, container).catch(() => undefined);
    container.remove();
  }
}
