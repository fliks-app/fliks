import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceService } from './device.service';

describe('DeviceService.reducedEffects', () => {
  function create(override: string | null, deviceMemory: number | undefined): DeviceService {
    if (override) localStorage.setItem('fliks.deviceOverride', override);
    else localStorage.removeItem('fliks.deviceOverride');
    Object.defineProperty(navigator, 'deviceMemory', { value: deviceMemory, configurable: true });
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    return TestBed.inject(DeviceService);
  }

  afterEach(() => {
    localStorage.removeItem('fliks.deviceOverride');
    delete (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    document.body.classList.remove('reduced-effects');
    TestBed.resetTestingModule();
  });

  it('is on for a TV whatever its memory', () => {
    const device = create('tv', undefined);
    expect(device.reducedEffects()).toBe(true);
    expect(document.body.classList.contains('reduced-effects')).toBe(true);
  });

  it('is on for a device reporting 4 GB or less', () => {
    expect(create('phone', 4).reducedEffects()).toBe(true);
  });

  it('stays off for a larger or unreported memory', () => {
    expect(create('desktop', 8).reducedEffects()).toBe(false);
    TestBed.resetTestingModule();
    expect(create('desktop', undefined).reducedEffects()).toBe(false);
    expect(document.body.classList.contains('reduced-effects')).toBe(false);
  });
});
