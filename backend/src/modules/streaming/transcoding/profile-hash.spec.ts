import {
  buildPlaybackProfileFromContext,
  computeProfileHash,
  type PlaybackProfile,
} from './profile-hash';
import type { SessionContext } from './types';

const BASE: PlaybackProfile = {
  videoCodec: 'h264',
  videoBitDepth: 8,
  hdr: null,
  audioCodec: 'aac',
  audioChannels: 2,
  audioMode: 'transcode',
  muxFlavour: 'fmp4',
  audioLayout: 'inline',
  segmentDurationMs: 3000,
  tvPlatform: 'browser',
};

describe('computeProfileHash', () => {
  it('returns a 10-char hex string', () => {
    const hash = computeProfileHash(BASE);
    expect(hash).toMatch(/^[0-9a-f]{10}$/);
  });

  it('is deterministic for the same input', () => {
    expect(computeProfileHash(BASE)).toBe(computeProfileHash({ ...BASE }));
  });

  it('changes when any single field changes', () => {
    const baseline = computeProfileHash(BASE);
    const variations: Array<Partial<PlaybackProfile>> = [
      { videoCodec: 'hevc' },
      { videoBitDepth: 10 },
      { hdr: 'HDR10' },
      { audioCodec: 'eac3' },
      { audioChannels: 6 },
      { audioMode: 'copy' },
      { muxFlavour: 'ts' },
      { audioLayout: 'var-stream-map' },
      { segmentDurationMs: 6000 },
      { tvPlatform: 'tizen' },
    ];
    for (const v of variations) {
      expect(computeProfileHash({ ...BASE, ...v })).not.toBe(baseline);
    }
  });

  it('separates HDR variants from SDR even when codec is identical', () => {
    const sdr = computeProfileHash({
      ...BASE,
      videoCodec: 'hevc',
      videoBitDepth: 10,
    });
    const hdr10 = computeProfileHash({
      ...BASE,
      videoCodec: 'hevc',
      videoBitDepth: 10,
      hdr: 'HDR10',
    });
    const hlg = computeProfileHash({
      ...BASE,
      videoCodec: 'hevc',
      videoBitDepth: 10,
      hdr: 'HLG',
    });
    expect(new Set([sdr, hdr10, hlg]).size).toBe(3);
  });

  it('separates tvPlatform classes even with otherwise-equal profiles', () => {
    const platforms: PlaybackProfile['tvPlatform'][] = [
      'browser',
      'androidtv',
      'tizen',
      'webos',
      'ios',
      'android',
      'cast',
    ];
    const hashes = platforms.map((tv) =>
      computeProfileHash({ ...BASE, tvPlatform: tv }),
    );
    expect(new Set(hashes).size).toBe(platforms.length);
  });
});

describe('buildPlaybackProfileFromContext', () => {
  it('returns safe defaults for an empty context', () => {
    const profile = buildPlaybackProfileFromContext(undefined, 3000);
    expect(profile.videoCodec).toBe('h264');
    expect(profile.videoBitDepth).toBe(8);
    expect(profile.hdr).toBeNull();
    expect(profile.audioCodec).toBe('aac');
    expect(profile.audioChannels).toBe(2);
    expect(profile.audioMode).toBe('transcode');
    expect(profile.muxFlavour).toBe('fmp4');
    expect(profile.audioLayout).toBe('inline');
    expect(profile.segmentDurationMs).toBe(3000);
    expect(profile.tvPlatform).toBe('browser');
  });

  it('propagates audio plan and video variant', () => {
    const ctx: SessionContext = {
      audioPlan: { mode: 'copy', codec: 'eac3' },
      videoVariant: { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
      useTs: false,
    };
    const profile = buildPlaybackProfileFromContext(ctx, 3000);
    expect(profile.audioCodec).toBe('eac3');
    expect(profile.audioMode).toBe('copy');
    expect(profile.audioChannels).toBe(6);
    expect(profile.videoCodec).toBe('hevc');
    expect(profile.videoBitDepth).toBe(10);
    expect(profile.hdr).toBe('HDR10');
  });

  it('picks the ts mux flavour for Tizen sessions', () => {
    const ctx: SessionContext = { useTs: true };
    expect(buildPlaybackProfileFromContext(ctx, 3000).muxFlavour).toBe('ts');
  });

  it('flips to var-stream-map when multi-audio + videoOnly', () => {
    const ctx: SessionContext = {
      videoOnly: true,
      audioStreams: [{ language: 'eng' }, { language: 'fre' }],
    };
    expect(buildPlaybackProfileFromContext(ctx, 3000).audioLayout).toBe(
      'var-stream-map',
    );
  });

  it('keeps inline audio layout when there is a single audio track', () => {
    const ctx: SessionContext = {
      videoOnly: true,
      audioStreams: [{ language: 'eng' }],
    };
    expect(buildPlaybackProfileFromContext(ctx, 3000).audioLayout).toBe(
      'inline',
    );
  });

  it('keeps the same hash for two ctx values that map to the same profile', () => {
    const a = buildPlaybackProfileFromContext(
      { audioPlan: { mode: 'transcode', codec: 'aac', bitrateBps: 128000 } },
      3000,
    );
    const b = buildPlaybackProfileFromContext(
      { audioPlan: { mode: 'transcode', codec: 'aac', bitrateBps: 192000 } },
      3000,
    );
    // Bitrate is not part of the profile — both should hash to the same dir.
    expect(computeProfileHash(a)).toBe(computeProfileHash(b));
  });
});
