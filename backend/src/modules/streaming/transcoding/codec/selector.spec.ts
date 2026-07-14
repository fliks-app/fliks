import { pickPrimaryVariant } from './selector';
import type { DeviceProfileDto } from '../../dto/device-profile.dto';

/** A native-style profile that lists AV1, HEVC and H.264 but caps the AV1
 *  decoder at 2048x2048 (no 4K AV1 HW path) while allowing 4K HEVC. */
function nativeProfile(): DeviceProfileDto {
  return {
    deviceType: 'mobile',
    supportsHdr: true,
    directPlayProfiles: [
      {
        containers: ['mp4', 'mkv'],
        videoCodecs: ['av1', 'hevc', 'hvc1', 'h264', 'avc1'],
        audioCodecs: ['aac', 'ac3', 'eac3'],
      },
    ],
    codecConditions: [
      { codec: 'av1', maxBitDepth: 10, maxWidth: 2048, maxHeight: 2048 },
      { codec: 'hevc', maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160 },
      { codec: 'h264', maxBitDepth: 8, maxWidth: 3840, maxHeight: 2160 },
    ],
  } as unknown as DeviceProfileDto;
}

describe('pickPrimaryVariant — client decode-resolution gate', () => {
  it('falls back to HEVC for a 4K AV1 source when the AV1 decoder caps at 2048', () => {
    const v = pickPrimaryVariant(
      { width: 3840, height: 2076, hdr: 'HDR10', codec: 'av1' },
      nativeProfile(),
      'none',
      '',
    );
    expect(v.codec).toBe('hevc');
    expect(v.hdr).toBe('HDR10');
  });

  it('un-trips for a rotated (portrait) 4K frame — long/short edges compared', () => {
    const v = pickPrimaryVariant(
      { width: 2076, height: 3840, hdr: 'HDR10', codec: 'av1' },
      nativeProfile(),
      'none',
      '',
    );
    expect(v.codec).toBe('hevc');
  });

  it('keeps AV1 for a 1080p source that fits the AV1 decoder cap', () => {
    const v = pickPrimaryVariant(
      { width: 1920, height: 1080, hdr: null, codec: 'av1' },
      nativeProfile(),
      'none',
      '',
    );
    expect(v.codec).toBe('av1');
  });

  it('does not gate codecs whose profile declares no resolution cap', () => {
    const profile = {
      deviceType: 'desktop',
      supportsHdr: false,
      directPlayProfiles: [
        {
          containers: ['mp4'],
          videoCodecs: ['av1', 'hevc', 'h264'],
          audioCodecs: ['aac'],
        },
      ],
      codecConditions: [{ codec: 'av1', maxBitDepth: 10 }],
    } as unknown as DeviceProfileDto;
    const v = pickPrimaryVariant(
      { width: 3840, height: 2160, hdr: null, codec: 'av1' },
      profile,
      'none',
      '',
    );
    expect(v.codec).toBe('av1');
  });
});
