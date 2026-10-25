import { describe, expect, it } from 'vitest';
import { CastPlayerService } from './cast-player.service';
import { CastDeviceCapabilities } from './cast-settings.service';

function profile(caps: CastDeviceCapabilities | null, hdr = true) {
  const self = {
    castSettings: { get: () => ({ hdr, audioChannels: 2 }), getDeviceCapabilities: () => caps },
    currentDeviceName: () => 'tv',
    receiverVideo: (c: CastDeviceCapabilities | null) =>
      (CastPlayerService.prototype as any).receiverVideo.call(self, c),
  };
  return CastPlayerService.prototype.getCastDeviceProfile.call(self as unknown as CastPlayerService);
}

const audioCodecs = ['aac'];

describe('getCastDeviceProfile video side', () => {
  it('lists no video codec without a probe answer', () => {
    const p = profile(null);
    expect(p.directPlayProfiles[0].videoCodecs).toEqual([]);
    expect(p.codecConditions).toEqual([]);
    expect(p.supportsHdr).toBe(false);
  });

  it('keeps a receiver that predates probe v2 on H.264 SDR', () => {
    const p = profile({ audioCodecs, videoCodecs: ['h264', 'hevc', 'av1'] });
    expect(p.directPlayProfiles[0].videoCodecs).toEqual([]);
    expect(p.supportsHdr).toBe(false);
  });

  it('lists h264 only when a v2 receiver reports nothing else', () => {
    const p = profile({ audioCodecs, videoCodecs: ['h264'], v: 2 });
    expect(p.directPlayProfiles[0].videoCodecs).toEqual(['h264', 'avc1']);
    expect(p.supportsHdr).toBe(false);
  });

  it('includes hevc and HDR when the receiver reports them', () => {
    const p = profile({ audioCodecs, videoCodecs: ['h264', 'hevc'], v: 2, hevcMain10: true, hdr: true });
    expect(p.directPlayProfiles[0].videoCodecs).toEqual(expect.arrayContaining(['h264', 'hevc', 'hvc1']));
    expect(p.codecConditions.find((c) => c.codec === 'hevc')).toMatchObject({ maxBitDepth: 10, maxLevel: 150 });
    expect(p.supportsHdr).toBe(true);
  });

  it('needs the user HDR setting and an HDR display', () => {
    const caps = { audioCodecs, videoCodecs: ['h264', 'hevc'], v: 2, hevcMain10: true, hdr: true };
    expect(profile(caps, false).supportsHdr).toBe(false);
    expect(profile({ ...caps, hdr: false }).supportsHdr).toBe(false);
    expect(profile({ ...caps, hevcMain10: false }).supportsHdr).toBe(false);
  });
});
