import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Media } from '../../../core/services/api/media.service';
import { AddToPlaylistService } from '../../../core/services/add-to-playlist.service';
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
  template: `<app-hero-carousel [items]="items" />`,
})
class Host {
  items = [item(1, 'movie'), item(2, 'series'), item(3, 'movie')];
}

function setup(tv = true, items?: Media[]) {
  const attached$ = new Subject<string>();
  const detached$ = new Subject<string>();
  const background = { set: vi.fn(), suspend: vi.fn() };
  const navbar = { navigatedBack: () => false };
  const start = {
    start: vi.fn().mockResolvedValue(undefined),
    playNext: vi.fn().mockResolvedValue(undefined),
    nextUpOf: vi.fn().mockResolvedValue({ media: { id: 2 }, next: { episode: { id: 21, episodeNumber: 7 }, season: { seasonNumber: 2 }, file: { id: 1 } }, resuming: true }),
  };
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
      { provide: DeviceService, useValue: { isTv: () => tv, reducedEffects: () => tv } },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  if (items) fixture.componentInstance.items = items;
  fixture.detectChanges();
  return { attached$, detached$, fixture, el: fixture.nativeElement as HTMLElement, background, start };
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
    expect(background.set).toHaveBeenLastCalledWith(expect.anything(), '/f1.jpg', { hero: true });
    vi.advanceTimersByTime(7000);
    fixture.detectChanges();
    expect(title(el)).toBe('T2');
    expect(background.set).toHaveBeenLastCalledWith(expect.anything(), '/f2.jpg', { hero: true });
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
    document.documentElement.classList.add('keyboard-modality');
    dot.dispatchEvent(new Event('focusin', { bubbles: true }));
    document.documentElement.classList.remove('keyboard-modality');
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

  it('stops and hands the backdrop back when the route detaches, and claims it again on attach', () => {
    const { detached$, attached$, el, background } = setup();
    detached$.next('k');
    expect(background.suspend).toHaveBeenCalled();
    vi.advanceTimersByTime(20000);
    expect(title(el)).toBe('T1');
    background.set.mockClear();
    attached$.next('k');
    expect(background.set).toHaveBeenCalledWith(expect.anything(), '/f1.jpg', { hero: true });
  });

  it('leaves the backdrop alone on the phone, which draws its own picture', () => {
    const { background } = setup(false);
    expect(background.set).not.toHaveBeenCalled();
  });

  it('draws its frame before its picks arrive, with no slide in it', () => {
    const { el } = setup(true, []);
    expect(el.querySelector('section.hc-frame')).not.toBeNull();
    expect(el.querySelector('.hc-slide')).toBeNull();
  });

  it('shows a dot per item and jumps on click', () => {
    const { fixture, el } = setup();
    const dots = el.querySelectorAll<HTMLButtonElement>('.hc-dot');
    expect(dots.length).toBe(3);
    dots[2].click();
    fixture.detectChanges();
    expect(title(el)).toBe('T3');
  });

  it('keeps the same primary element while a series swaps Details for Play', async () => {
    const { fixture, el, start } = setup();
    let resolve!: (v: unknown) => void;
    start.nextUpOf.mockReturnValue(new Promise((r) => (resolve = r)));
    el.querySelectorAll<HTMLButtonElement>('.hc-dot')[1].click();
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(10);
    fixture.detectChanges();
    const before = el.querySelector('.hc-slide:not(.hc-out) .btn-light');
    resolve({ media: {}, next: { episode: { id: 21, episodeNumber: 7 }, season: { seasonNumber: 2 }, file: { id: 1 } }, resuming: false });
    await vi.advanceTimersByTimeAsync(10);
    fixture.detectChanges();
    const after = el.querySelector('.hc-slide:not(.hc-out) .btn-light');
    expect(after).toBe(before);
    expect(after?.textContent).toContain('hero_carousel.play_episode');
  });

  it('plays a movie, and a series at its next episode with a Details link beside it', async () => {
    const { fixture, el, start } = setup();
    el.querySelector<HTMLButtonElement>('.btn-light')!.click();
    expect(start.start).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    el.querySelectorAll<HTMLButtonElement>('.hc-dot')[1].click();
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(10);
    fixture.detectChanges();
    expect(start.nextUpOf).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    const slide = el.querySelector('.hc-slide:not(.hc-out)')!;
    const primary = slide.querySelector('.btn-light')!;
    expect(primary.tagName).toBe('BUTTON');
    expect(primary.textContent).toContain('hero_carousel.resume_episode');
    expect(slide.querySelector('a.btn-glass')?.getAttribute('href')).toBe('/series/2');
    (primary as HTMLButtonElement).click();
    expect(start.playNext).toHaveBeenCalledWith({ id: 2 }, expect.objectContaining({ episode: expect.objectContaining({ id: 21 }) }));
    expect(start.start).toHaveBeenCalledTimes(1);
  });

  it('opens the add-to-playlist modal for the slide from the plus button, with the kind badge and facts in the line', () => {
    const { el } = setup();
    el.querySelector<HTMLButtonElement>('.btn-square')!.click();
    expect(TestBed.inject(AddToPlaylistService).request()?.target).toEqual({ mediaId: 1 });
    const meta = el.querySelector('.hc-slide:not(.hc-out) app-hero-meta-row')!;
    expect(meta.textContent).toContain('2020');
    expect(meta.querySelector('.badge')?.textContent).toContain('requests.type_movie');
  });

  it('keeps one primary button that opens the detail page while a series has nothing to play', async () => {
    const { fixture, el, start } = setup();
    start.nextUpOf.mockResolvedValue({ media: {}, next: null, resuming: false });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    el.querySelectorAll<HTMLButtonElement>('.hc-dot')[1].click();
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(10);
    fixture.detectChanges();
    const primary = el.querySelector<HTMLButtonElement>('.hc-slide:not(.hc-out) .btn-light')!;
    expect(primary.tagName).toBe('BUTTON');
    primary.click();
    expect(navigate).toHaveBeenCalledWith(['/series', '2'], { state: { media: expect.objectContaining({ id: 2 }) } });
  });

});
