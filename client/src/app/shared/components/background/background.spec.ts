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

  it('lets a hero claim through at the top of the page only', async () => {
    const hero = signal<'full' | 'compact' | null>('full');
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: BackgroundService, useValue: { url: signal('/f.jpg'), blur: signal(false), hero } },
        { provide: DeviceService, useValue: { isTv: () => false, reducedEffects: () => false } },
      ],
    });
    const fixture = TestBed.createComponent(BackgroundComponent);
    const el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    expect(el.querySelector('.app-bg-hero-veil-on')).not.toBeNull();
    expect(el.querySelector('.app-bg-veil-off')).not.toBeNull();
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(5000);
    window.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(el.querySelector('.app-bg-hero-veil-on')).toBeNull();
    expect(el.querySelector('.app-bg-veil-off')).toBeNull();
  });
});
