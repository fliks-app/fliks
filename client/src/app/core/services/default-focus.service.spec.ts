import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultFocusService, type DefaultFocusTarget } from './default-focus.service';
import { DeviceService } from './device.service';
import { FocusMemoryService } from './focus-memory.service';
import { NavbarService } from './navbar.service';

describe('DefaultFocusService', () => {
  let host: HTMLElement;
  let back = false;

  /** No layout engine here: a visible button gets a box at `top`, a hidden one keeps the empty rect. */
  const button = (id: string, parent: HTMLElement = host, hidden = false, top = 10): HTMLButtonElement => {
    const b = parent.appendChild(document.createElement('button'));
    b.setAttribute('data-home-focus', id);
    b.textContent = id;
    b.scrollIntoView = vi.fn();
    if (!hidden) {
      Object.defineProperty(b, 'offsetParent', { get: () => document.body });
      b.getBoundingClientRect = () => ({ left: 0, top, width: 100, height: 40, right: 100, bottom: top + 40, x: 0, y: top, toJSON: () => ({}) });
    }
    return b;
  };
  const target = (selector: string): DefaultFocusTarget => ({ host, selector, focusKey: 'home', focusIdAttr: 'data-home-focus' });

  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'));
    back = false;
    TestBed.configureTestingModule({
      providers: [
        { provide: DeviceService, useValue: { isTv: () => true } },
        { provide: NavbarService, useValue: { lastWasBack: () => back } },
      ],
    });
  });
  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  it('re-reads the declared selector while it waits, so a row that arrives late wins', async () => {
    const svc = TestBed.inject(DefaultFocusService);
    let selector = "[data-home-focus='hero:primary']";
    svc.applyOnArrival(() => target(selector));
    // The data arrives: the selector now prefers the resume row, and both render.
    selector = "[data-home-focus^='cw:']";
    button('cw:1');
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement?.getAttribute('data-home-focus')).toBe('cw:1');
  });

  it('does not scroll to a target that is already on screen', () => {
    const svc = TestBed.inject(DefaultFocusService);
    const cw = button('cw:1');
    svc.applyOnArrival(() => target("[data-home-focus^='cw:']"));
    expect(document.activeElement).toBe(cw);
    expect(cw.scrollIntoView).not.toHaveBeenCalled();
  });

  it('brings a target that is out of view into it', () => {
    const svc = TestBed.inject(DefaultFocusService);
    const cw = button('cw:1', host, false, window.innerHeight + 100);
    svc.applyOnArrival(() => target("[data-home-focus^='cw:']"));
    expect(cw.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('restores a visible stand-in when the remembered nth item is hidden', () => {
    const svc = TestBed.inject(DefaultFocusService);
    const memory = TestBed.inject(FocusMemoryService);
    // A carousel: one primary button per slide, only the active one shown.
    button('hero:primary', host, true);
    const shown = button('hero:primary');
    button('cw:1');
    memory.save('home', 'hero:primary', 0);
    back = true;
    svc.applyOnArrival(() => target("[data-home-focus^='cw:']"));
    expect(document.activeElement).toBe(shown);
  });

  it('falls back to the declared target when the remembered item is gone', () => {
    const svc = TestBed.inject(DefaultFocusService);
    const memory = TestBed.inject(FocusMemoryService);
    const cw = button('cw:1');
    memory.save('home', 'cw:99', 0);
    back = true;
    svc.applyOnArrival(() => target("[data-home-focus^='cw:']"));
    expect(document.activeElement).toBe(cw);
  });
});
