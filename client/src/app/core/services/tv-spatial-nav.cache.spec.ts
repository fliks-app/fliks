import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TvSpatialNavService, nearestDelta } from './tv-spatial-nav.service';

function button(parent: HTMLElement, x: number): HTMLButtonElement {
  const el = document.createElement('button');
  Object.defineProperty(el, 'offsetParent', { get: () => parent });
  el.getBoundingClientRect = () => ({ left: x, top: 0, width: 40, height: 40, right: x + 40, bottom: 40, x, y: 0, toJSON: () => ({}) });
  parent.append(el);
  return el;
}

const flush = () => new Promise((r) => setTimeout(r));

describe('TvSpatialNavService focusable cache', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps a grid list across a cosmetic change elsewhere and drops it when the grid gains a child', async () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as { focusablesIn(root: ParentNode): HTMLElement[] };
    const grid = document.body.appendChild(document.createElement('div'));
    const other = document.body.appendChild(document.createElement('div'));
    button(grid, 0);
    await flush();

    const first = nav.focusablesIn(grid);
    expect(first).toHaveLength(1);
    other.style.color = 'red';
    await flush();
    expect(nav.focusablesIn(grid)).toBe(first);

    button(grid, 50);
    await flush();
    expect(nav.focusablesIn(grid)).toHaveLength(2);
  });

  it('drops the list of an overlay mounted under <html> when its content swaps', async () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as { focusablesIn(root: ParentNode): HTMLElement[] };
    const overlay = document.documentElement.appendChild(document.createElement('div'));
    button(overlay, 0);
    await flush();
    expect(nav.focusablesIn(overlay)).toHaveLength(1);

    overlay.replaceChildren();
    button(overlay, 0);
    button(overlay, 50);
    await flush();
    expect(nav.focusablesIn(overlay)).toHaveLength(2);
    overlay.remove();
  });
});

describe('nearestDelta', () => {
  it('scrolls like block: nearest', () => {
    // Inside the view, or spanning it: no scroll.
    expect(nearestDelta(100, 200, 0, 500)).toBe(0);
    expect(nearestDelta(-100, 600, 0, 500)).toBe(0);
    // Above the view: its top meets the view's top; below: its bottom meets the view's bottom.
    expect(nearestDelta(-50, 50, 0, 500)).toBe(-50);
    expect(nearestDelta(450, 550, 0, 500)).toBe(50);
    // Taller than the view: the other edge aligns.
    expect(nearestDelta(-50, 600, 0, 500)).toBe(0);
    expect(nearestDelta(100, 700, 0, 500)).toBe(100);
  });
});

describe('TvSpatialNavService down from a seekbar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('prefers the button aligned with the seekbar among a row at the same height', () => {
    const nav = TestBed.inject(TvSpatialNavService) as unknown as { findNeighbor(dir: string): HTMLElement | null };
    const at = (el: HTMLElement, x: number, y: number, w: number, h: number) => {
      Object.defineProperty(el, 'offsetParent', { get: () => document.body });
      el.getBoundingClientRect = () => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON: () => ({}) });
      document.body.append(el);
      return el;
    };
    const seek = at(document.createElement('button'), 24, 780, 1872, 30);
    const side = at(document.createElement('button'), 672, 891, 60, 60);
    const play = at(document.createElement('button'), 909, 870, 102, 102);
    seek.focus();
    expect(nav.findNeighbor('down')).toBe(play);
    expect(side).not.toBe(play);
  });
});
