import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { afterEach, vi } from 'vitest';
import { AuthService } from './auth.service';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { DeviceService } from './device.service';
import { PlayerSettingsService } from './player-settings.service';
import { ServerConfigService } from './server-config.service';
import { SystemInfoService } from './system-info.service';

/** One platform fixture: what its engine answers, and which device it is. */
interface Fixture {
  /** MIME fragments `isTypeSupported` accepts. */
  mse: string[];
  /** MIME prefixes `canPlayType` accepts (the audio element and the sample entries). */
  plays?: string[];
  hdrDisplay?: boolean;
  tvPlatform?: 'tizen' | 'webos' | 'androidtv' | null;
  desktop?: boolean;
  native?: 'android' | 'ios';
  webapis?: unknown;
  webOSSystem?: unknown;
  nativeVideo?: unknown;
  nativeAudio?: unknown;
  nativeHdr?: { supported: boolean; dolbyVision?: boolean };
  mpv?: { decoders: string[]; demuxers: string[] };
}

const CHROME = ['avc1', 'hvc1.1.6', 'hvc1.2.4', 'av01.0.08M', 'vp09', 'vp8', 'mp4a.40.2', 'opus', 'flac'];

const FIXTURES: Record<string, Fixture> = {
  'chrome-desktop': { mse: CHROME, plays: ['audio/mpeg', 'audio/flac', 'audio/ogg', 'video/mp4'], hdrDisplay: true },
  'firefox-no-hevc': { mse: ['avc1', 'av01.0.08M', 'vp09', 'vp8', 'mp4a.40.2', 'opus', 'flac'], plays: ['audio/mpeg', 'audio/flac'] },
  'tizen-2021': {
    mse: ['avc1', 'mp4a.40.2'],
    tvPlatform: 'tizen',
    webapis: {
      systeminfo: {
        isSupportedVideoCodec: (c: string) => ['H264', 'HEVC', 'VP9', 'AV1'].includes(c),
        isSupportedAudioCodec: (c: string) => ['AAC', 'AC3', 'E-AC-3'].includes(c),
      },
      productinfo: { isUdPanelSupported: () => true, is8KPanelSupported: () => false },
      avinfo: { isHdrTvSupport: () => true },
      avplay: {},
    },
  },
  'tizen-2019': {
    mse: ['avc1', 'mp4a.40.2'],
    tvPlatform: 'tizen',
    webapis: { productinfo: { isUdPanelSupported: () => true, is8KPanelSupported: () => false }, avplay: {} },
  },
  'webos-2025-uhd': {
    mse: ['avc1', 'hvc1.1.6', 'hvc1.2.4', 'av01.0.08M', 'mp4a.40.2', 'ac-3', 'ec-3'],
    plays: ['video/mp4; codecs="hvc1', 'video/mp4; codecs="dvh1'],
    tvPlatform: 'webos',
    webOSSystem: { deviceInfo: JSON.stringify({ sdkVersion: '10.0.0', screenWidth: 3840, hdr10: true, dolbyVision: true }) },
  },
  'webos-2019-fhd': {
    mse: ['avc1', 'mp4a.40.2'],
    tvPlatform: 'webos',
    webOSSystem: { deviceInfo: JSON.stringify({ sdkVersion: '4.5.0', screenWidth: 1920 }) },
  },
  'desktop-mpv': {
    mse: ['avc1', 'mp4a.40.2'],
    desktop: true,
    mpv: {
      decoders: ['h264', 'hevc', 'av1', 'vp9', 'vc1', 'mpeg2video', 'aac', 'ac3', 'eac3', 'dts', 'truehd', 'flac', 'opus'],
      demuxers: ['mov', 'matroska', 'webm', 'mpegts', 'avi'],
    },
  },
  'android-native': {
    mse: ['avc1'],
    native: 'android',
    nativeHdr: { supported: true, dolbyVision: false },
    nativeVideo: {
      videoCodecs: ['h264', 'hevc', 'vp9'],
      hevcMain10: true,
      av1Main10: false,
      containers: ['mp4', 'm4v', 'mov', 'webm', 'mkv'],
      resolutions: { hevc: { width: 4096, height: 2160 } },
      dolbyVisionProfiles: [],
      cropsBlackBars: true,
    },
    nativeAudio: {
      codecs: ['aac', 'mp3', 'flac', 'opus'],
      maxChannels: 6,
      audioFiles: { containers: ['mp3', 'flac'], videoCodecs: [], audioCodecs: ['mp3', 'flac'] },
    },
  },
  'ios-native': {
    mse: ['avc1', 'hvc1.1.6'],
    plays: ['video/mp4; codecs="hvc1', 'video/mp4; codecs="avc1'],
    native: 'ios',
    nativeHdr: { supported: true, dolbyVision: true },
    nativeVideo: { videoCodecs: ['h264', 'hevc'], hevcMain10: true, av1Main10: false, containers: ['mp4', 'm4v', 'mov'], cropsBlackBars: true },
    nativeAudio: {
      codecs: ['aac', 'alac', 'mp3'],
      maxChannels: 8,
      audioFiles: { containers: ['mp3', 'aac', 'mp4'], videoCodecs: [], audioCodecs: ['mp3', 'aac', 'alac'] },
    },
  },
};

function profileOf(f: Fixture) {
  const mse = (mime: string) => f.mse.some((x) => mime.includes(x));
  vi.stubGlobal('MediaSource', { isTypeSupported: mse });
  vi.stubGlobal('matchMedia', () => ({ matches: !!f.hdrDisplay }));
  vi.stubGlobal('AudioContext', class { destination = { maxChannelCount: 2 }; close() {} });
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((m) => ((f.plays ?? []).some((p) => m.startsWith(p)) ? 'probably' : ''));
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(!!f.native);
  vi.spyOn(Capacitor, 'getPlatform').mockReturnValue(f.native ?? 'web');
  Object.assign(window, { webapis: f.webapis, webOSSystem: f.webOSSystem });
  TestBed.configureTestingModule({
    providers: [
      BrowserDeviceProfileService,
      {
        provide: DeviceService,
        useValue: {
          isTv: () => !!f.tvPlatform,
          tvPlatform: () => f.tvPlatform ?? null,
          isDesktopNative: () => !!f.desktop,
          isIosNative: () => f.native === 'ios',
        },
      },
      { provide: PlayerSettingsService, useValue: { get: () => ({ forceDisableHdr: false }) } },
      { provide: ServerConfigService, useValue: { isNative: !!f.native } },
      { provide: SystemInfoService, useValue: { systemName: () => '' } },
      { provide: AuthService, useValue: { hasServerFeature: () => true } },
    ],
  });
  const service = TestBed.inject(BrowserDeviceProfileService);
  const internals = service as unknown as Record<string, unknown>;
  Object.assign(internals, {
    nativeVideo: f.nativeVideo ?? null,
    nativeAudio: f.nativeAudio ?? null,
    nativeHdr: f.nativeHdr?.supported ?? null,
    nativeDolbyVision: f.nativeHdr?.dolbyVision ?? null,
    mpv: f.mpv ?? null,
    cachedProfile: null,
  });
  return { ...service.getProfile(), deviceName: undefined, deviceId: undefined, appVersion: undefined };
}

describe('the generated device profile, per platform', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (window as any).webapis;
    delete (window as any).webOSSystem;
  });

  it.each(Object.keys(FIXTURES))('%s', (name) => {
    expect(profileOf(FIXTURES[name])).toMatchSnapshot();
  });
});
