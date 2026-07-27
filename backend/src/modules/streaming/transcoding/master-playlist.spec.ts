import { generateMasterPlaylist } from './master-playlist';
import type { CodecVariant } from './codec/types';

const HEVC_HDR10: CodecVariant = { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' };
const HEVC_HLG: CodecVariant = { codec: 'hevc', bitDepth: 10, hdr: 'HLG' };
const AV1_HDR10: CodecVariant = { codec: 'av1', bitDepth: 10, hdr: 'HDR10' };

/** Build an HDR master for a 3840×2160 source (the full HDR ladder fits). */
function hdrMaster(
  hdrVariant: CodecVariant,
  opts: { hdrFormat?: 'HDR10' | 'HLG'; canEmitHdrLadder?: boolean } = {},
): string {
  const { hdrFormat = 'HDR10', canEmitHdrLadder = true } = opts;
  return generateMasterPlaylist({
    mediaFileId: 1,
    sourceWidth: 3840,
    sourceHeight: 2160,
    tokenParam: '',
    hdrPassThrough: { hdrFormat, hdrVariant },
    canEmitHdrLadder,
    sourceFrameRate: 24,
  });
}

const streamInfLines = (m: string): string[] =>
  m.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF'));

describe('generateMasterPlaylist — HDR ladder is variant-driven (#464)', () => {
  it('emits HEVC Main10 CODECS + VIDEO-RANGE=PQ for a HEVC HDR variant (QSV path unchanged)', () => {
    const lines = streamInfLines(hdrMaster(HEVC_HDR10));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toContain('VIDEO-RANGE=PQ');
      expect(l).toMatch(/CODECS="hvc1\.2\.4\.L\d+\.B0/);
      expect(l).not.toContain('av01');
    }
    // The 2160p rung at 24fps lands on L5.0 (L150) — the regression lock.
    expect(lines.some((l) => l.includes('hvc1.2.4.L150.B0'))).toBe(true);
  });

  it('emits AV1 CODECS (av01.*.10) + VIDEO-RANGE=PQ for an AV1 HDR variant', () => {
    const lines = streamInfLines(hdrMaster(AV1_HDR10));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toContain('VIDEO-RANGE=PQ');
      expect(l).toMatch(/CODECS="av01\.0\.\d+M\.10/);
      expect(l).not.toContain('hvc1');
    }
  });

  it('emits VIDEO-RANGE=HLG for an HLG variant', () => {
    const lines = streamInfLines(hdrMaster(HEVC_HLG, { hdrFormat: 'HLG' }));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toContain('VIDEO-RANGE=HLG');
  });

  it('emits no HDR rungs when the host has no encoder for the variant', () => {
    const lines = streamInfLines(
      hdrMaster(AV1_HDR10, { canEmitHdrLadder: false }),
    );
    expect(lines).toHaveLength(0);
  });
});

describe('generateMasterPlaylist — audio rendition CHANNELS', () => {
  const mediaLines = (m: string): string[] =>
    m.split('\n').filter((l) => l.startsWith('#EXT-X-MEDIA:TYPE=AUDIO'));

  it('declares the resolved output channels, not the source layout', () => {
    // 7.1 (8ch) source: track 0 transcoded to E-AC-3 ships 6, track 1 copied keeps 8.
    const m = generateMasterPlaylist({
      mediaFileId: 1,
      sourceWidth: 1920,
      sourceHeight: 1080,
      tokenParam: '',
      outputAudioCodec: 'eac3',
      audioStreams: [{ channels: 8 }, { channels: 8 }],
      audioOutputChannels: [6, 8],
    });
    const media = mediaLines(m);
    expect(media[0]).toContain('CHANNELS="6"');
    expect(media[1]).toContain('CHANNELS="8"');
  });

  it('falls back to the codec-derived count when output channels are absent', () => {
    const m = generateMasterPlaylist({
      mediaFileId: 1,
      sourceWidth: 1920,
      sourceHeight: 1080,
      tokenParam: '',
      outputAudioCodec: 'eac3',
      audioStreams: [{ channels: 6 }],
    });
    expect(mediaLines(m)[0]).toContain('CHANNELS="6"');
  });
});

describe('generateMasterPlaylist — supportsAbr collapses the ladder', () => {
  const base = {
    mediaFileId: 1,
    sourceWidth: 1920,
    sourceHeight: 1080,
    tokenParam: '',
  };

  it('no onlyQuality + supportsAbr:false collapses to the single top-fitting rung', () => {
    const m = generateMasterPlaylist({ ...base, supportsAbr: false });
    expect(streamInfLines(m)).toHaveLength(1);
    expect(m).toContain('/1080p/');
  });

  it('no onlyQuality + supportsAbr:true (or unset) keeps the full ladder unchanged', () => {
    const withFlag = generateMasterPlaylist({ ...base, supportsAbr: true });
    const withoutFlag = generateMasterPlaylist(base);
    expect(streamInfLines(withFlag).length).toBeGreaterThan(1);
    expect(withFlag).toEqual(withoutFlag);
  });

  it('an explicit onlyQuality still wins over supportsAbr:false', () => {
    const m = generateMasterPlaylist({
      ...base,
      supportsAbr: false,
      onlyQuality: '720p',
    });
    expect(streamInfLines(m)).toHaveLength(1);
    expect(m).toContain('/720p/');
  });
});

describe('generateMasterPlaylist — audio bitrate in BANDWIDTH', () => {
  const maxAvgBandwidth = (m: string): number =>
    Math.max(
      ...[...m.matchAll(/AVERAGE-BANDWIDTH=(\d+)/g)].map((x) => Number(x[1])),
    );

  it('folds the real output audio bitrate into AVERAGE-BANDWIDTH', () => {
    const base = {
      mediaFileId: 1,
      sourceWidth: 1920,
      sourceHeight: 1080,
      tokenParam: '',
    };
    const hi = generateMasterPlaylist({ ...base, audioOutputBitrateBps: 640_000 });
    const lo = generateMasterPlaylist({ ...base, audioOutputBitrateBps: 100_000 });
    // Same video rungs; only the audio component differs by the exact delta.
    expect(maxAvgBandwidth(hi) - maxAvgBandwidth(lo)).toBe(540_000);
  });
});
