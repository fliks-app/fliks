import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Media } from '../../../core/services/api/media.service';
import { BackgroundService } from '../../../core/services/background.service';
import { DeviceService } from '../../../core/services/device.service';
import { AppResumeService } from '../../../core/services/app-resume.service';
import { CachingReuseStrategy } from '../../../core/services/route-reuse.strategy';
import { ScrollMemoryService } from '../../../core/services/scroll-memory.service';
import { MediaStartService } from '../../../core/services/media-start.service';
import { NavbarService } from '../../../core/services/navbar.service';
import { HeroCarouselComponent } from './hero-carousel';

const item = (id: number, type: string): Media =>
  ({ id, type, title: `T${id}`, year: 2020, runtime: 90, rating: 7, genres: ['Drama'], overview: 'o', fanartUrl: `/f${id}.jpg`, logoUrl: null, files: [{ id }] }) as unknown as Media;

@Component({
  imports: [HeroCarouselComponent],
  template: `<app-hero-carousel [items]="items" [height]="height" />`,
})
class Host {
  items = [item(1, 'movie'), item(2, 'series'), item(3, 'movie')];
  height: 'full' | 'compact' = 'full';
}

function setup(height: 'full' | 'compact' = 'full') {
  const attached$ = new Subject<string>();
  const detached$ = new Subject<string>();
  const background = { set: vi.fn(), suspend: vi.fn() };
  const navbar = { enterHeroPage: vi.fn(), leaveHeroPage: vi.fn(), heroPaddingTop: () => null };
  const start = { start: vi.fn().mockResolvedValue(undefined) };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: CachingReuseStrategy, useValue: { attached$, detached$, keyFor: () => 'k' } },
      { provide: ActivatedRoute, useValue: { snapshot: {} } },
      { provide: ScrollMemoryService, useValue: {} },
      { provide: AppResumeService, useValue: { resume$: new Subject() } },
      { provide: BackgroundService, useValue: background },
      { provide: NavbarService, useValue: navbar },
      { provide: MediaStartService, useValue: start },
      { provide: DeviceService, useValue: { isTv: () => true, reducedEffects: () => true } },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.height = height;
  fixture.detectChanges();
  return { attached$, detached$, fixture, el: fixture.nativeElement as HTMLElement, background, navbar, start };
}

const mq = (matches: boolean) => ({ matches, addEventListener: () => {}, removeEventListener: () => {} });
const title = (el: HTMLElement) => el.querySelector('.hc-slide:not(.hc-out) h2')?.textContent?.trim();

describe('HeroCarouselComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => mq(false));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('claims the backdrop and advances on the timer, claiming each slide', () => {
    const { fixture, el, background } = setup();
    expect(title(el)).toBe('T1');
    expect(background.set).toHaveBeenLastCalledWith(expect.anything(), '/f1.jpg');
    vi.advanceTimersByTime(7000);
    fixture.detectChanges();
    expect(title(el)).toBe('T2');
    expect(background.set).toHaveBeenLastCalledWith(expect.anything(), '/f2.jpg');
  });

  it('holds while a mouse hovers or the keyboard focuses, not after a tap', () => {
    const { fixture, el } = setup();
    const host = el.querySelector('app-hero-carousel')!;
    const pointer = (type: string, pointerType: string) => {
      const e = new Event(type);
      Object.defineProperty(e, 'pointerType', { value: pointerType });
      host.dispatchEvent(e);
    };
    pointer('pointerenter', 'touch');
    fixture.detectChanges();
    vi.advanceTimersByTime(7000);
    fixture.detectChanges();
    expect(title(el)).toBe('T2');
    pointer('pointerenter', 'mouse');
    fixture.detectChanges();
    vi.advanceTimersByTime(20000);
    expect(title(el)).toBe('T2');
    pointer('pointerleave', 'mouse');
    const dot = el.querySelector<HTMLElement>('.hc-dot')!;
    vi.spyOn(dot, 'matches').mockReturnValue(true);
    dot.dispatchEvent(new Event('focusin', { bubbles: true }));
    fixture.detectChanges();
    vi.advanceTimersByTime(20000);
    expect(title(el)).toBe('T2');
  });

  it('does not auto-advance under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => mq(true));
    const { el } = setup();
    vi.advanceTimersByTime(20000);
    expect(title(el)).toBe('T1');
  });

  it('hands the chrome back and stops when the route detaches, and claims it again on attach', () => {
    const { detached$, attached$, el, background, navbar } = setup();
    expect(navbar.enterHeroPage).toHaveBeenCalled();
    detached$.next('k');
    expect(navbar.leaveHeroPage).toHaveBeenCalled();
    expect(background.suspend).toHaveBeenCalled();
    vi.advanceTimersByTime(20000);
    expect(title(el)).toBe('T1');
    background.set.mockClear();
    attached$.next('k');
    expect(background.set).toHaveBeenCalledWith(expect.anything(), '/f1.jpg');
  });

  it('leaves the host chrome alone when compact', () => {
    const { navbar, background } = setup('compact');
    expect(navbar.enterHeroPage).not.toHaveBeenCalled();
    expect(background.set).toHaveBeenCalled();
  });

  it('shows a dot per item and jumps on click', () => {
    const { fixture, el } = setup();
    const dots = el.querySelectorAll<HTMLButtonElement>('.hc-dot');
    expect(dots.length).toBe(3);
    dots[2].click();
    fixture.detectChanges();
    expect(title(el)).toBe('T3');
  });

  it('plays a movie and opens a series detail page', () => {
    const { fixture, el, start } = setup();
    el.querySelector<HTMLButtonElement>('[data-home-focus="hero:primary"]')!.click();
    expect(start.start).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    el.querySelectorAll<HTMLButtonElement>('.hc-dot')[1].click();
    fixture.detectChanges();
    const primary = el.querySelector('.hc-slide:not(.hc-out) [data-home-focus="hero:primary"]')!;
    expect(primary.tagName).toBe('A');
    expect(primary.getAttribute('href')).toBe('/series/2');
  });
});
