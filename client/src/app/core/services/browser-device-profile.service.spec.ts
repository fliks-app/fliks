import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { vi } from 'vitest';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { DeviceService } from './device.service';
import { PlayerSettingsService } from './player-settings.service';
import { ServerConfigService } from './server-config.service';
import { SystemInfoService } from './system-info.service';
import { AuthService } from './auth.service';

/** Minimal DI graph, only the members `buildProfile()` actually reads. */
function configure(
  device: Pick<DeviceService, 'isTv' | 'tvPlatform' | 'isDesktopNative'>,
  auth: Pick<AuthService, 'hasServerFeature'> = { hasServerFeature: () => true },
) {
  TestBed.configureTestingModule({
    providers: [
      BrowserDeviceProfileService,
      { provide: DeviceService, useValue: device },
      { provide: PlayerSettingsService, useValue: { get: () => ({ forceDisableHdr: false }) } },
      { provide: ServerConfigService, useValue: { isNative: false } },
      { provide: SystemInfoService, useValue: { systemName: () => '' } },
      { provide: AuthService, useValue: auth },
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

  it('is false for Firefox, whose audioTracks does not switch the audible track', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
    );
    const service = configure({
      isTv: () => false,
      tvPlatform: () => null,
      isDesktopNative: () => false,
    } as DeviceService);
    expect(service.getProfile().switchesDirectPlayAudio).toBe(false);
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

describe('BrowserDeviceProfileService: container detection', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    delete (globalThis as unknown as { MediaSource?: unknown }).MediaSource;
  });

  it('lists mp4/webm when isTypeSupported rejects the bare mime but accepts a codec string', () => {
    (globalThis as unknown as { MediaSource: unknown }).MediaSource = {
      isTypeSupported: (mime: string) => mime.includes('codecs='),
    };
    const service = configure({
      isTv: () => false,
      tvPlatform: () => null,
      isDesktopNative: () => false,
    } as DeviceService);
    const containers = service.getProfile().directPlayProfiles[0].containers;
    expect(containers).toContain('mp4');
    expect(containers).toContain('webm');
  });

  it('falls back to canPlayType with a codec string when MediaSource is absent', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation(
      (mime: string) => (mime.includes('codecs=') ? 'probably' : ''),
    );
    const service = configure({
      isTv: () => false,
      tvPlatform: () => null,
      isDesktopNative: () => false,
    } as DeviceService);
    expect(service.getProfile().directPlayProfiles[0].containers).toContain('mp4');
  });
});

describe('BrowserDeviceProfileService: dolbyVisionProfiles gating', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });
  const device = {
    isTv: () => false,
    tvPlatform: () => null,
    isDesktopNative: () => false,
  } as DeviceService;

  it('omits the field entirely when the server has not advertised deviceProfileExtensions', () => {
    const service = configure(device, { hasServerFeature: () => false });
    expect(service.getProfile().dolbyVisionProfiles).toBeUndefined();
  });

  it('omits an empty list even when the server advertises deviceProfileExtensions', () => {
    const service = configure(device, { hasServerFeature: () => true });
    expect(service.getProfile().dolbyVisionProfiles).toBeUndefined();
  });

  it('sends a non-empty list once the server advertises deviceProfileExtensions', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const service = configure(device, { hasServerFeature: () => true });
    expect(service.getProfile().dolbyVisionProfiles).toEqual([5, 8, 10]);
    vi.unstubAllGlobals();
  });
});
