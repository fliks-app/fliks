import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TvSpatialNavService } from './tv-spatial-nav.service';

type Nav = {
  registerContainer(el: HTMLElement, o: { orientation: 'vertical' | 'horizontal' }): void;
  findNeighbor(dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null;
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
});
