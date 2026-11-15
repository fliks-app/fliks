import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceService } from '../../../core/services/device.service';
import { ControlsVisibilityService } from './controls-visibility';

describe('ControlsVisibilityService pointer moves', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('keeps the bar up while the pointer moves, without restarting the effect, and hides after the last move', () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ControlsVisibilityService,
        { provide: DeviceService, useValue: { isTouch: () => false, isDpad: () => false, isTv: () => false } },
      ],
    });
    const chrome = TestBed.inject(ControlsVisibilityService);
    TestBed.tick();
    const bump = vi.spyOn(chrome, 'resetHideTimer');

    vi.advanceTimersByTime(2000);
    chrome.onPointerMove();
    vi.advanceTimersByTime(2000);
    expect(chrome.visible()).toBe(true);
    expect(bump).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(chrome.visible()).toBe(false);

    chrome.onPointerMove();
    expect(chrome.visible()).toBe(true);
  });
});
