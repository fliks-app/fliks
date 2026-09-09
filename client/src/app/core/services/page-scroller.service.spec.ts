import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { Subject, firstValueFrom } from 'rxjs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PageScrollerService } from './page-scroller.service';

describe('PageScrollerService', () => {
  let events: Subject<unknown>;

  beforeEach(() => {
    events = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: Router, useValue: { events } },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  const service = () => TestBed.inject(PageScrollerService);

  it('falls back to the document when nothing has claimed the scroller', () => {
    const s = service();
    expect(s.element()).toBeNull();
    expect(s.offset()).toBe(window.scrollY);
  });

  it('claim/release: offset() and changes() follow the claim', async () => {
    const s = service();
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollTop', { value: 42, writable: true });

    s.claim(el);
    expect(s.element()).toBe(el);
    expect(s.offset()).toBe(42);

    const next = firstValueFrom(s.changes());
    el.dispatchEvent(new Event('scroll'));
    await next;

    s.release(el);
    expect(s.element()).toBeNull();
    expect(s.offset()).toBe(window.scrollY);
  });

  it('same-owner guard: release() no-ops unless the caller still owns the claim', () => {
    const s = service();
    const elA = document.createElement('div');
    const elB = document.createElement('div');

    s.claim(elA);
    s.claim(elB);
    // A page navigated away from (elA) releasing after the next page (elB)
    // already claimed must not wipe elB's claim.
    s.release(elA);
    expect(s.element()).toBe(elB);

    s.release(elB);
    expect(s.element()).toBeNull();
  });

  it('clears a claim left behind by a page that forgot to release, on the next navigation', () => {
    const s = service();
    const detached = document.createElement('div');
    s.claim(detached);

    events.next(new NavigationEnd(1, '/next', '/next'));

    expect(s.element()).toBeNull();
  });

  it('leaves a claim alone across a navigation while its element is still live', () => {
    const s = service();
    const live = document.createElement('div');
    document.body.appendChild(live);
    s.claim(live);

    events.next(new NavigationEnd(1, '/next', '/next'));

    expect(s.element()).toBe(live);
    document.body.removeChild(live);
  });
});
