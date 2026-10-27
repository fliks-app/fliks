import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TvSpatialNavService } from './tv-spatial-nav.service';

function button(parent: HTMLElement, x: number): HTMLButtonElement {
  const el = document.createElement('button');
  Object.defineProperty(el, 'offsetParent', { get: () => parent });
  el.getBoundingClientRect = () => ({ left: x, top: 0, width: 40, height: 40, right: x + 40, bottom: 40, x, y: 0, toJSON: () => ({}) });
  parent.append(el);
  return el;
}

const flush = () => new Promise((r) => setTimeout(r));

describe('TvSpatialNavService focus rescue', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.classList.remove('keyboard-modality');
  });

  it('hands the focus of a swapped-out button to its nearest replacement, under keyboard only', async () => {
    TestBed.inject(TvSpatialNavService);
    document.documentElement.classList.add('keyboard-modality');
    const parent = document.body.appendChild(document.createElement('div'));
    const join = button(parent, 0);
    join.focus();
    join.remove();
    const far = button(parent, 200);
    const near = button(parent, 10);
    await flush();
    expect(document.activeElement).toBe(near);
    expect(far).not.toBe(document.activeElement);
  });

  it('gives the focus back to a button re-enabled after a busy spell', async () => {
    TestBed.inject(TvSpatialNavService);
    document.documentElement.classList.add('keyboard-modality');
    const parent = document.body.appendChild(document.createElement('div'));
    const save = button(parent, 0);
    save.focus();
    save.disabled = true;
    save.blur();
    await flush();
    save.disabled = false;
    await flush();
    expect(document.activeElement).toBe(save);
  });
});
