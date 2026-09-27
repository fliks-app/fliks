import { TestBed } from '@angular/core/testing';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { DeviceService } from './device.service';
import { PlayerSettingsService } from './player-settings.service';
import { ServerConfigService } from './server-config.service';
import { SystemInfoService } from './system-info.service';

/** Minimal DI graph — only the members `buildProfile()` actually reads. */
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

describe('BrowserDeviceProfileService — cropsBlackBarsLocally', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is true for a plain web browser — the Shaka path crops via CSS transform', () => {
    const service = configure({
      isTv: () => false,
      tvPlatform: () => null,
      isDesktopNative: () => false,
    } as DeviceService);
    expect(service.getProfile().cropsBlackBarsLocally).toBe(true);
  });

  it('is true for the desktop shell — mpv crops at the VO', () => {
    const service = configure({
      isTv: () => false,
      tvPlatform: () => null,
      isDesktopNative: () => true,
    } as DeviceService);
    expect(service.getProfile().cropsBlackBarsLocally).toBe(true);
  });

  it('is false for a TV engine — Tizen/webOS have no client-side crop path', () => {
    const service = configure({
      isTv: () => true,
      tvPlatform: () => 'webos',
      isDesktopNative: () => false,
    } as DeviceService);
    expect(service.getProfile().cropsBlackBarsLocally).toBe(false);
  });
});
