import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TvSpatialNavService } from './tv-spatial-nav.service';

type Nav = {
  registerContainer(el: HTMLElement, o: { orientation: 'vertical' | 'horizontal' }): void;
  findNeighborInTree(active: HTMLElement, dir: 'down'): HTMLElement | null;
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
});
