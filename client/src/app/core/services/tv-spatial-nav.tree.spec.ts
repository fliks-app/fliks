import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TvSpatialNavService } from './tv-spatial-nav.service';

type Nav = {
  registerContainer(el: HTMLElement, o: { orientation: 'vertical' | 'horizontal'; isWrapping?: boolean }): void;
  findNeighbor(dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null;
  onKey(e: KeyboardEvent): void;
  leaveRail(): boolean;
  scrollToFocus(el: HTMLElement, style: CSSStyleDeclaration): void;
  performMove(dir: 'left' | 'right' | 'up' | 'down', crossZones: boolean): void;
  findNeighborInTree(active: HTMLElement, dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null;
};

function box<T extends HTMLElement>(el: T, top: number, height: number): T {
  Object.defineProperty(el, 'offsetParent', { get: () => document.body });
  el.getBoundingClientRect = () => ({ left: 0, top, width: 400, height, right: 400, bottom: top + height, x: 0, y: top, toJSON: () => ({}) });
  return el;
}

function row(top: number): { row: HTMLElement; button: HTMLButtonElement } {
  const r = box(document.createElement('div'), top, 40);
  const button = box(document.createElement('button'), top, 40);
  r.append(button);
  return { row: r, button };
}

describe('TvSpatialNavService tree', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('finds the section of a row registered before it was attached under it', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const section = document.body.appendChild(box(document.createElement('div'), 0, 300));
    nav.registerContainer(section, { orientation: 'vertical' });
    const top = row(0);
    section.append(top.row);
    nav.registerContainer(top.row, { orientation: 'horizontal' });

    // Projected content: its container registers while still detached.
    const picker = row(100);
    nav.registerContainer(picker.row, { orientation: 'horizontal' });
    const episodes = row(200);
    section.append(picker.row, episodes.row);
    nav.registerContainer(episodes.row, { orientation: 'horizontal' });

    expect(nav.findNeighborInTree(picker.button, 'down')).toBe(episodes.button);
  });

  /** A rail on the left and a page section in `<main>` beside it. */
  function railAndPage(nav: Nav) {
    const rail = document.body.appendChild(box(document.createElement('nav'), 0, 400));
    rail.setAttribute('data-tv-nav', '');
    nav.registerContainer(rail, { orientation: 'vertical' });
    const home = box(document.createElement('a'), 0, 40);
    home.href = '/';
    const library = box(document.createElement('a'), 50, 40);
    library.href = '/libraries/x';
    library.setAttribute('aria-current', 'page');
    rail.append(home, library);

    const main = document.body.appendChild(document.createElement('main'));
    const page = main.appendChild(box(document.createElement('div'), 0, 400));
    nav.registerContainer(page, { orientation: 'vertical' });
    const cards = row(0);
    const second = box(document.createElement('button'), 0, 40);
    second.getBoundingClientRect = () => ({ left: 450, top: 0, width: 400, height: 40, right: 850, bottom: 40, x: 450, y: 0, toJSON: () => ({}) });
    cards.row.append(second);
    page.append(cards.row);
    nav.registerContainer(cards.row, { orientation: 'horizontal' });
    return { rail, home, library, page, first: cards.button, second };
  }

  it('enters the rail on its current entry with Left from the first card of a page row', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { library, first } = railAndPage(nav);
    expect(nav.findNeighborInTree(first, 'left')).toBe(library);
  });

  it('keeps Left inside a row until its first card', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { first, second } = railAndPage(nav);
    expect(nav.findNeighborInTree(second, 'left')).toBe(first);
  });

  it('digs into the page with Right from the rail', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { home, first } = railAndPage(nav);
    expect(nav.findNeighborInTree(home, 'right')).toBe(first);
  });

  it('never bridges up or down from a page container to the rail', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { first } = railAndPage(nav);
    expect(nav.findNeighborInTree(first, 'up')).toBeNull();
    expect(nav.findNeighborInTree(first, 'down')).toBeNull();
  });

  const at = (el: HTMLElement, left: number, top: number): void => {
    el.getBoundingClientRect = () => ({ left, top, width: 100, height: 40, right: left + 100, bottom: top + 40, x: left, y: top, toJSON: () => ({}) });
  };

  it('returns to the card the user left with Right from the rail', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { library, second } = railAndPage(nav);
    second.focus();
    library.focus();
    expect(nav.findNeighbor('right')).toBe(second);
  });

  it('ends Up and Down at the rail edges instead of leaving it', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { home, library } = railAndPage(nav);
    library.focus();
    expect(nav.findNeighbor('down')).toBeNull();
    home.focus();
    expect(nav.findNeighbor('up')).toBeNull();
  });

  it('enters the rail on its current entry from a page with no container', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { library } = railAndPage(nav);
    const loose = document.querySelector('main')!.appendChild(document.createElement('button'));
    Object.defineProperty(loose, 'offsetParent', { get: () => document.body });
    at(loose, 500, 200);
    loose.focus();
    expect(nav.findNeighbor('left')).toBe(library);
  });

  it('keeps Left on a neighbour in the same container instead of bridging to the rail', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { page } = railAndPage(nav);
    const a = page.appendChild(document.createElement('button'));
    const b = page.appendChild(document.createElement('button'));
    for (const el of [a, b]) Object.defineProperty(el, 'offsetParent', { get: () => document.body });
    at(a, 500, 300);
    at(b, 650, 300);
    b.focus();
    expect(nav.findNeighborInTree(b, 'left')).toBeNull();
    expect(nav.findNeighbor('left')).toBe(a);
  });

  it('still enters the rail when the only focusable to the left sits on another line', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { page, library, first } = railAndPage(nav);
    const other = page.appendChild(document.createElement('button'));
    Object.defineProperty(other, 'offsetParent', { get: () => document.body });
    at(other, 0, 300);
    first.focus();
    expect(nav.findNeighborInTree(first, 'left')).toBe(library);
  });

  it('never scrolls the page when Up or Down runs out of rail entries', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { home, library, first } = railAndPage(nav);
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    library.focus();
    nav.performMove('down', true);
    home.focus();
    nav.performMove('up', true);
    expect(scrollBy).not.toHaveBeenCalled();
    scrollBy.mockRestore();
  });

  it('leaves a text field marked skip-spatial for the rail once its caret is at the left edge', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { library, page } = railAndPage(nav);
    const input = page.appendChild(document.createElement('input'));
    input.setAttribute('data-tv-skip-spatial', '');
    Object.defineProperty(input, 'offsetParent', { get: () => document.body });
    at(input, 500, 200);
    input.value = 'abc';
    input.focus();
    input.setSelectionRange(2, 2);
    nav.onKey(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
    expect(document.activeElement).toBe(input);
    input.setSelectionRange(0, 0);
    nav.onKey(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
    expect(document.activeElement).toBe(library);
  });

  it('lets Left leave a looping row from its first child for the rail', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { library, page } = railAndPage(nav);
    const loop = page.appendChild(box(document.createElement('div'), 200, 40));
    nav.registerContainer(loop, { orientation: 'horizontal', isWrapping: true });
    const a = loop.appendChild(document.createElement('button'));
    const b = loop.appendChild(document.createElement('button'));
    for (const el of [a, b]) Object.defineProperty(el, 'offsetParent', { get: () => document.body });
    at(a, 500, 200);
    at(b, 650, 200);
    a.focus();
    expect(nav.findNeighbor('left')).toBe(library);
    b.focus();
    expect(nav.findNeighbor('left')).toBe(a);
    // Right from the last child still loops.
    expect(nav.findNeighbor('right')).toBe(a);
  });

  it('enters a row on its aria-current child, whatever it remembered (the active carousel dot)', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const carousel = document.body.appendChild(box(document.createElement('div'), 0, 200));
    nav.registerContainer(carousel, { orientation: 'horizontal' });
    const play = carousel.appendChild(document.createElement('button'));
    const dots = carousel.appendChild(box(document.createElement('div'), 150, 20));
    nav.registerContainer(dots, { orientation: 'horizontal' });
    const [d0, d1, d2] = [0, 1, 2].map(() => dots.appendChild(document.createElement('button')));
    for (const el of [play, d0, d1, d2]) Object.defineProperty(el, 'offsetParent', { get: () => document.body });
    // The dots sit under the actions on the left; the last action is to their right, as in the carousel.
    at(play, 300, 100);
    dots.getBoundingClientRect = () => ({ left: 0, top: 150, width: 60, height: 20, right: 60, bottom: 170, x: 0, y: 150, toJSON: () => ({}) });
    [d0, d1, d2].forEach((d, i) => at(d, 20 * i, 150));
    d0.focus();
    d2.setAttribute('aria-current', 'true');
    play.focus();
    expect(nav.findNeighborInTree(play, 'right')).toBe(d2);
  });

  it('hands focus back to the page item it came from when Back leaves the rail', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { library, second } = railAndPage(nav);
    expect(nav.leaveRail()).toBe(false);
    second.focus();
    library.focus();
    second.scrollIntoView = () => undefined;
    expect(nav.leaveRail()).toBe(true);
    expect(document.activeElement).toBe(second);
    // Focus already on the page: Back goes on to the rest of the chain.
    expect(nav.leaveRail()).toBe(false);
  });

  it('never enters the rail with Up or Down at the edges of the page', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
    const { home, library, first } = railAndPage(nav);
    // Rail entries above and below the page's only row: the nearest candidates in both directions.
    at(home, 0, -100);
    at(library, 0, 300);
    first.focus();
    expect(nav.findNeighbor('up')).toBeNull();
    expect(nav.findNeighbor('down')).toBeNull();
  });

  describe('back to the top of the page', () => {
    afterEach(() => {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
      vi.restoreAllMocks();
    });

    it('scrolls the page to the very top when Up finds nothing above', () => {
      const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
      const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
      const lone = document.body.appendChild(box(document.createElement('button'), 0, 40));
      lone.focus();
      nav.performMove('up', true);
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    });

    it('brings a first-screen element back to scroll 0 rather than a partial reveal', () => {
      const nav = TestBed.inject(TvSpatialNavService) as unknown as Nav;
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 300 });
      const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
      const el = document.body.appendChild(box(document.createElement('button'), -200, 40));
      el.scrollIntoView = vi.fn();
      nav.scrollToFocus(el, getComputedStyle(el));
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
      expect(el.scrollIntoView).not.toHaveBeenCalled();
    });
  });
});
