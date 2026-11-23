import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundService } from '../../../core/services/background.service';
import { DeviceService } from '../../../core/services/device.service';
import { BackgroundComponent } from './background';

describe('BackgroundComponent', () => {
  it('carries the blur flag on each layer, so a sharp image is never drawn blurred', async () => {
    const url = signal<string | null>('/cover.jpg');
    const blur = signal(true);
    const hero = signal<'full' | 'compact' | null>(null);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: BackgroundService, useValue: { url, blur, hero } },
        { provide: DeviceService, useValue: { isTv: () => false, reducedEffects: () => false } },
      ],
    });
    const fixture = TestBed.createComponent(BackgroundComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.layers().filter((l) => l.url)).toEqual([{ url: '/cover.jpg', blur: true }]);
    url.set('/fanart.jpg');
    blur.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    const used = fixture.componentInstance.layers().filter((l) => l.url);
    expect(used).toEqual([{ url: '/fanart.jpg', blur: false }]);
  });

  it('shades a hero claim continuously from the scroll position, never leaving the veil off', () => {
    const hero = signal<'full' | 'compact' | null>('full');
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: BackgroundService, useValue: { url: signal('/f.jpg'), blur: signal(false), hero } },
        { provide: DeviceService, useValue: { isTv: () => false, reducedEffects: () => false } },
      ],
    });
    const fixture = TestBed.createComponent(BackgroundComponent);
    const veil = fixture.nativeElement as HTMLElement;
    const bottomAlpha = () => {
      fixture.detectChanges();
      const bg = veil.querySelector<HTMLElement>('.app-bg-veil')!.style.background;
      return Number(/rgba\(29, 35, 42, ([\d.]+)\) \d+%, rgba\(29, 35, 42, ([\d.]+)\) \d+%\)/.exec(bg)?.[1]);
    };
    const scrollTo = (y: number) => {
      vi.spyOn(window, 'scrollY', 'get').mockReturnValue(y);
      window.dispatchEvent(new Event('scroll'));
    };
    expect(bottomAlpha()).toBe(0);
    scrollTo(window.innerHeight * 0.1);
    expect(bottomAlpha()).toBeGreaterThan(0.4);
    expect(bottomAlpha()).toBeLessThan(0.5);
    scrollTo(5000);
    expect(bottomAlpha()).toBeCloseTo(0.95, 2);
    hero.set(null);
    expect(bottomAlpha()).toBeNaN();
  });
});
