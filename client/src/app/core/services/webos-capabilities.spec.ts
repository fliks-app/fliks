import { afterEach, vi } from 'vitest';
import { webosAudioCodecs, webosDevice, webosMkvProfile, webosVideo } from './webos-capabilities';

const chromium = (major: number) =>
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/${major}.0.0.0 Safari/537.36 WebAppManager`);

describe('webosDevice', () => {
  afterEach(() => {
    delete (window as any).webOSSystem;
    vi.restoreAllMocks();
  });

  it('reads the platform, panel and HDR flags from webOSSystem.deviceInfo', () => {
    (window as any).webOSSystem = {
      deviceInfo: JSON.stringify({ platformVersion: '10.3.1', screenWidth: 3840, hdr10: true, dolbyVision: 'false' }),
    };
    expect(webosDevice()).toEqual({ year: 2025, uhd: true, hdr10: true, dolbyVision: false });
  });

  it.each([
    ['3.0.0', 2016], ['4.5.0', 2018], ['5.0.0', 2020], ['6.0.0', 2021], ['7.0.0', 2022], ['9.1.0', 2024],
  ])('dates platform %s to model year %i', (platformVersion, year) => {
    (window as any).webOSSystem = { deviceInfo: JSON.stringify({ platformVersion }) };
    expect(webosDevice()?.year).toBe(year);
  });

  it('dates the TV by its Chromium when the firmware gives no platform', () => {
    chromium(120);
    expect(webosDevice()).toEqual({ year: 2025, uhd: null, hdr10: null, dolbyVision: null });
  });

  it('survives an unreadable deviceInfo', () => {
    (window as any).webOSSystem = { deviceInfo: '{nope' };
    chromium(94);
    expect(webosDevice()?.year).toBe(2023);
  });
});

describe('webosMkvProfile', () => {
  it('lists the Ultra HD ceiling for a UHD panel and for an unknown one', () => {
    const uhd = { year: 2025, uhd: true, hdr10: null, dolbyVision: null };
    for (const d of [uhd, null]) {
      const p = webosMkvProfile(d);
      expect(p.containers).toEqual(['mkv', 'matroska']);
      expect(p.videoCodecs).toEqual(['h264', 'avc1', 'hevc', 'h265', 'hvc1']);
      expect(p.audioCodecs).toEqual(['ac3', 'eac3', 'aac']);
    }
  });

  it('lists the full MKV row for a Full HD panel, AV1 from 2020 and Opus from 2024', () => {
    const fhd = (year: number) => webosMkvProfile({ year, uhd: false, hdr10: null, dolbyVision: null });
    expect(fhd(2019).videoCodecs).toContain('vp9');
    expect(fhd(2019).videoCodecs).not.toContain('av1');
    expect(fhd(2021).videoCodecs).toContain('av1');
    expect(fhd(2021).audioCodecs).not.toContain('opus');
    expect(fhd(2024).audioCodecs).toEqual(['ac3', 'eac3', 'aac', 'mp3', 'opus']);
  });
});

describe('webosVideo and webosAudioCodecs', () => {
  it('declares HEVC and MP3 that every release lists, whatever the probe said', () => {
    const v = webosVideo({ containers: ['mp4'], videoCodecs: ['h264', 'avc1'], codecConditions: [] });
    expect(v.videoCodecs).toEqual(['h264', 'avc1', 'hevc', 'h265', 'hvc1']);
    expect(v.codecConditions).toEqual([{ codec: 'hevc', profiles: ['main', 'main 10'], maxBitDepth: 10 }]);
    expect(webosAudioCodecs(['aac'])).toEqual(['aac', 'mp3']);
  });

  it('keeps a probe that already found HEVC', () => {
    const probed = { containers: [], videoCodecs: ['hevc'], codecConditions: [{ codec: 'hevc', maxLevel: 153 }] };
    expect(webosVideo(probed)).toBe(probed);
  });
});
