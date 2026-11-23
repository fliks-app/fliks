import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Media } from '../../../core/services/api/media.service';
import { BackgroundService } from '../../../core/services/background.service';
import { DeviceService } from '../../../core/services/device.service';
import { MediaStartService } from '../../../core/services/media-start.service';
import { NavbarService } from '../../../core/services/navbar.service';
import { HeroCarouselComponent } from './hero-carousel';

const item = (id: number, type: string): Media =>
  ({ id, type, title: `T${id}`, year: 2020, runtime: 90, rating: 7, genres: ['Drama'], overview: 'o', fanartUrl: `/f${id}.jpg`, logoUrl: null, files: [{ id }] }) as unknown as Media;

@Component({
  imports: [HeroCarouselComponent],
  template: `<app-hero-carousel [items]="items" [parked]="parked()" />`,
})
class Host {
  items = [item(1, 'movie'), item(2, 'series'), item(3, 'movie')];
  parked = signal(false);
}

function setup() {
  const background = { set: vi.fn(), suspend: vi.fn() };
  const navbar = { enterHeroPage: vi.fn(), leaveHeroPage: vi.fn(), heroPaddingTop: () => null };
  const start = { start: vi.fn().mockResolvedValue(undefined) };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: BackgroundService, useValue: background },
      { provide: NavbarService, useValue: navbar },
      { provide: MediaStartService, useValue: start },
      { provide: DeviceService, useValue: { isTv: () => true, reducedEffects: () => true } },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, background, navbar, start };
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

  it('holds while hovered, focused or hidden', () => {
    const { fixture, el } = setup();
    const host = el.querySelector('app-hero-carousel')!;
    host.dispatchEvent(new Event('mouseenter'));
    fixture.detectChanges();
    vi.advanceTimersByTime(20000);
    expect(title(el)).toBe('T1');
    host.dispatchEvent(new Event('mouseleave'));
    host.dispatchEvent(new Event('focusin'));
    fixture.detectChanges();
    vi.advanceTimersByTime(20000);
    expect(title(el)).toBe('T1');
  });

  it('does not auto-advance under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => mq(true));
    const { el } = setup();
    vi.advanceTimersByTime(20000);
    expect(title(el)).toBe('T1');
  });

  it('hands the chrome back and stops while the route is parked', () => {
    const { fixture, el, background, navbar } = setup();
    expect(navbar.enterHeroPage).toHaveBeenCalled();
    fixture.componentInstance.parked.set(true);
    fixture.detectChanges();
    expect(navbar.leaveHeroPage).toHaveBeenCalled();
    expect(background.suspend).toHaveBeenCalled();
    vi.advanceTimersByTime(20000);
    expect(title(el)).toBe('T1');
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
