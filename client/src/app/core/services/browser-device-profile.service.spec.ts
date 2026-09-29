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

describe('BrowserDeviceProfileService, cropsBlackBarsLocally on Capacitor', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  function nativeService(nativeVideo: Record<string, unknown> | null) {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const service = configure({
      isTv: () => false,
      tvPlatform: () => null,
      isDesktopNative: () => false,
    } as DeviceService);
    const internals = service as unknown as { nativeVideo: unknown; cachedProfile: unknown };
    internals.nativeVideo = nativeVideo;
    internals.cachedProfile = null;
    return service;
  }

  const caps = { videoCodecs: ['h264'], hevcMain10: false, av1Main10: false, containers: ['mp4'] };

  it('is true once the plugin reports cropsBlackBars', () => {
    const service = nativeService({ ...caps, cropsBlackBars: true });
    expect(service.getProfile().cropsBlackBarsLocally).toBe(true);
    expect(service.nativeCropsBlackBars()).toBe(true);
  });

  it('is false when the plugin build does not report the capability', () => {
    const service = nativeService(caps);
    expect(service.getProfile().cropsBlackBarsLocally).toBe(false);
    expect(service.nativeCropsBlackBars()).toBe(false);
  });

  it('is false before the capabilities probe resolves', () => {
    const service = nativeService(null);
    expect(service.getProfile().cropsBlackBarsLocally).toBe(false);
  });
});

describe('BrowserDeviceProfileService, native codec levels', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const caps = {
    videoCodecs: ['h264', 'hevc'],
    hevcMain10: true,
    av1Main10: false,
    containers: ['mp4'],
  };

  function nativeProfile(platform: string) {
    vi.stubGlobal('MediaSource', {
      isTypeSupported: (t: string) =>
        /avc1\.(42E01E|42001E|42001F|640028|640029)/.test(t) || /hvc1\.\d\.\d\.L(120|123|150|153)\.B0/.test(t),
    });
    const service = configure({
      isTv: () => false,
      tvPlatform: () => null,
      isDesktopNative: () => false,
    } as DeviceService);
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue(platform as never);
    const internals = service as unknown as { nativeVideo: unknown; cachedProfile: unknown };
    internals.nativeVideo = caps;
    internals.cachedProfile = null;
    return service.getProfile();
  }

  it('iOS keeps the probed maxLevel of each codec the plugin reports', () => {
    const conditions = nativeProfile('ios').codecConditions ?? [];
    expect(conditions.find((c) => c.codec === 'h264')?.maxLevel).toBe(41);
    expect(conditions.find((c) => c.codec === 'hevc')?.maxLevel).toBe(153);
  });

  it('Android leaves the level to the plugin', () => {
    const conditions = nativeProfile('android').codecConditions ?? [];
    expect(conditions.find((c) => c.codec === 'h264')?.maxLevel).toBeUndefined();
    expect(conditions.find((c) => c.codec === 'hevc')?.maxLevel).toBeUndefined();
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

  it('adds profile 7 for the desktop shell, mpv decodes raw dual-layer P7', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const desktopDevice = { ...device, isDesktopNative: () => true } as DeviceService;
    const service = configure(desktopDevice, { hasServerFeature: () => true });
    expect(service.getProfile().dolbyVisionProfiles).toEqual([5, 8, 10, 7]);
    expect(service.getProfile().supportsDolbyVision).toBe(true);
    vi.unstubAllGlobals();
  });

  it('still lists profile 7 on an SDR desktop display (mpv tone-maps locally)', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const desktopDevice = { ...device, isDesktopNative: () => true } as DeviceService;
    const service = configure(desktopDevice, { hasServerFeature: () => true });
    expect(service.getProfile().dolbyVisionProfiles).toEqual([7]);
    // 5/8 still require a real HDR display; only 7 bypasses supportsHdr.
    expect(service.getProfile().supportsDolbyVision).toBe(false);
    vi.unstubAllGlobals();
  });

  it('stays pessimistic (7 only) on Windows desktop before the capability bridge answers', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/30.0.0',
    );
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const desktopDevice = { ...device, isDesktopNative: () => true } as DeviceService;
    const service = configure(desktopDevice, { hasServerFeature: () => true });
    // No bridge is wired up in this test, so the constructor's probe never
    // resolves — the pessimistic default holds, same as a bridge that answers
    // canReshapeDolbyVision: false.
    expect(service.getProfile().dolbyVisionProfiles).toEqual([7]);
    expect(service.getProfile().supportsDolbyVision).toBe(false);
    vi.unstubAllGlobals();
  });

  it('does not force 5/8 on a non-Windows desktop', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/30.0.0',
    );
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const desktopDevice = { ...device, isDesktopNative: () => true } as DeviceService;
    const service = configure(desktopDevice, { hasServerFeature: () => true });
    expect(service.getProfile().dolbyVisionProfiles).toEqual([7]);
    vi.unstubAllGlobals();
  });

  it('drops 5/8 on Windows desktop once mpv reports it fell back off gpu-next', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/30.0.0',
    );
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    (window as unknown as { fliksDesktop: unknown }).fliksDesktop = {
      getPlayerCapabilities: () => Promise.resolve({ canReshapeDolbyVision: false }),
    };
    try {
      const desktopDevice = { ...device, isDesktopNative: () => true } as DeviceService;
      const service = configure(desktopDevice, { hasServerFeature: () => true });
      // Flush the constructor's getPlayerCapabilities() microtask before reading.
      await Promise.resolve();
      await Promise.resolve();
      expect(service.getProfile().dolbyVisionProfiles).toEqual([7]);
    } finally {
      delete (window as unknown as { fliksDesktop?: unknown }).fliksDesktop;
      vi.unstubAllGlobals();
    }
  });

  it('lists 5/7/8 on Windows desktop once the bridge confirms it can reshape', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/30.0.0',
    );
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    (window as unknown as { fliksDesktop: unknown }).fliksDesktop = {
      getPlayerCapabilities: () => Promise.resolve({ canReshapeDolbyVision: true }),
    };
    try {
      const desktopDevice = { ...device, isDesktopNative: () => true } as DeviceService;
      const service = configure(desktopDevice, { hasServerFeature: () => true });
      await service.whenDesktopProbed();
      expect(service.getProfile().dolbyVisionProfiles).toEqual([5, 7, 8]);
      expect(service.getProfile().supportsDolbyVision).toBe(true);
    } finally {
      delete (window as unknown as { fliksDesktop?: unknown }).fliksDesktop;
      vi.unstubAllGlobals();
    }
  });
});
