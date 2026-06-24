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
