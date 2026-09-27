import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { vi } from 'vitest';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { DeviceService } from './device.service';
import { PlayerSettingsService } from './player-settings.service';
import { ServerConfigService } from './server-config.service';
import { SystemInfoService } from './system-info.service';

/** Minimal DI graph, only the members `buildProfile()` actually reads. */
function configure(device: Pick<DeviceService, 'isTv' | 'tvPlatform' | 'isDesktopNative'>) {
  TestBed.configureTestingModule({
    providers: [
      BrowserDeviceProfileService,
      { provide: DeviceService, useValue: device },
      { provide: PlayerSettingsService, useValue: { get: () => ({ forceDisableHdr: false }) } },
      { provide: ServerConfigService, useValue: { isNative: false } },
      { provide: SystemInfoService, useValue: { systemName: () => '' } },
    ],
  });
  return TestBed.inject(BrowserDeviceProfileService);
}

describe('BrowserDeviceProfileService, cropsBlackBarsLocally', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is true for a plain web browser, the Shaka path crops via CSS transform', () => {
    const service = configure({
      isTv: () => false,
      tvPlatform: () => null,
      isDesktopNative: () => false,
    } as DeviceService);
    expect(service.getProfile().cropsBlackBarsLocally).toBe(true);
  });

  it('is true for the desktop shell, mpv crops at the VO', () => {
    const service = configure({
      isTv: () => false,
      tvPlatform: () => null,
      isDesktopNative: () => true,
    } as DeviceService);
    expect(service.getProfile().cropsBlackBarsLocally).toBe(true);
  });

  it('is false for a TV engine, Tizen/webOS have no client-side crop path', () => {
    const service = configure({
      isTv: () => true,
      tvPlatform: () => 'webos',
      isDesktopNative: () => false,
    } as DeviceService);
    expect(service.getProfile().cropsBlackBarsLocally).toBe(false);
  });
});

describe('BrowserDeviceProfileService: switchesDirectPlayAudio', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('sends the real browser probe for a plain web browser', () => {
    const service = configure({
      isTv: () => false,
      tvPlatform: () => null,
      isDesktopNative: () => false,
    } as DeviceService);
    expect(service.getProfile().switchesDirectPlayAudio).toBe(
      'audioTracks' in HTMLMediaElement.prototype,
    );
  });

  it('is undefined for native mobile: an absent key already reads as true on the backend', () => {
    const service = configure({
      isTv: () => false,
      tvPlatform: () => null,
      isDesktopNative: () => false,
    } as DeviceService);
    // After construction, so the native capability probes never start.
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    expect(service.getProfile().switchesDirectPlayAudio).toBeUndefined();
  });

  it('is undefined for the desktop shell', () => {
    const service = configure({
      isTv: () => false,
      tvPlatform: () => null,
      isDesktopNative: () => true,
    } as DeviceService);
    expect(service.getProfile().switchesDirectPlayAudio).toBeUndefined();
  });

  it('is undefined for a TV engine', () => {
    const service = configure({
      isTv: () => true,
      tvPlatform: () => 'tizen',
      isDesktopNative: () => false,
    } as DeviceService);
    expect(service.getProfile().switchesDirectPlayAudio).toBeUndefined();
  });
});
