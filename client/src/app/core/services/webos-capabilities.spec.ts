import { afterEach, vi } from 'vitest';
import { webosAudioCodecs, webosDevice, webosMkvProfile, webosVideo } from './webos-capabilities';

const chromium = (major: number) =>
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/${major}.0.0.0 Safari/537.36 WebAppManager`);

describe('webosDevice', () => {
  afterEach(() => {
    delete (window as any).webOSSystem;
    vi.restoreAllMocks();
  });

  it('dates the TV by its Chromium and reads the panel and HDR flags from webOSSystem.deviceInfo', () => {
    chromium(120);
    (window as any).webOSSystem = {
      deviceInfo: JSON.stringify({ platformVersion: '02.16.30', sdkVersion: '10.0.0', screenWidth: 3840, hdr10: true, dolbyVision: 'false' }),
    };
    expect(webosDevice()).toEqual({ year: 2025, uhd: true, hdr10: true, dolbyVision: false });
  });

  it.each([[132, 2026], [120, 2025], [108, 2024], [94, 2023], [87, 2022], [79, 2021], [68, 2020], [53, 2018]])(
    'dates Chromium %i to model year %i',
    (major, year) => {
      chromium(major);
      expect(webosDevice()?.year).toBe(year);
    },
  );

  it.each([['4.5.0', 2018], ['5.0.0', 2020], ['6.0.0', 2021], ['7.0.0', 2022], ['11.0.0', 2026]])(
    'falls back to SDK %s, model year %i, when the UA has no Chromium',
    (sdkVersion, year) => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Web0S');
      (window as any).webOSSystem = { deviceInfo: JSON.stringify({ sdkVersion }) };
      expect(webosDevice()?.year).toBe(year);
    },
  );

  it('survives an unreadable deviceInfo', () => {
    (window as any).webOSSystem = { deviceInfo: '{nope' };
    chromium(94);
    expect(webosDevice()).toEqual({ year: 2023, uhd: null, hdr10: null, dolbyVision: null });
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
