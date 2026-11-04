import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { BackgroundService } from '../../../core/services/background.service';
import { TvService } from '../../../core/services/tv.service';
import { BackgroundComponent } from './background';

describe('BackgroundComponent', () => {
  it('carries the blur flag on each layer, so a sharp image is never drawn blurred', async () => {
    const url = signal<string | null>('/cover.jpg');
    const blur = signal(true);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: BackgroundService, useValue: { url, blur } },
        { provide: TvService, useValue: { isTv: () => false } },
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
});
