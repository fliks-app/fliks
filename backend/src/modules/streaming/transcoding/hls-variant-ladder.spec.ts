import {
  buildUniqueAudioNames,
  emitAudioRenditions,
  emitVariantLadder,
  type VariantLadderOptions,
} from './hls-variant-ladder';
import type { CodecVariant } from './codec/types';
import type { TranscodeProfile } from './types';

const PROFILE: TranscodeProfile = {
  name: '1080p',
  maxWidth: 1920,
  maxHeight: 1080,
  videoBitrate: '8M',
  audioBitrate: '192k',
};

function emit(variant: CodecVariant, range?: 'PQ' | 'HLG'): string[] {
  const lines: string[] = [];
  const opts: VariantLadderOptions = {
    profiles: [PROFILE],
    variant,
    range,
    audioAttr: '',
    subsAttr: '',
    frameRateAttr: ',FRAME-RATE=24',
    codecsTail: ',mp4a.40.2',
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceFrameRate: 24,
    sourceVideoBitrateBps: 100_000_000,
    sourceVideoCodec: 'hevc',
    mediaFileId: 1,
    tokenParam: '',
  };
  emitVariantLadder(lines, opts);
  return lines;
}

describe('emitVariantLadder — codec string + VIDEO-RANGE from the variant', () => {
  it('HEVC HDR → Main10 codec string + VIDEO-RANGE', () => {
    const [inf] = emit({ codec: 'hevc', bitDepth: 10, hdr: 'HDR10' }, 'PQ');
    expect(inf).toContain('CODECS="hvc1.2.4.');
    expect(inf).toContain('VIDEO-RANGE=PQ');
  });

  it('HEVC SDR → Main codec string, no VIDEO-RANGE', () => {
    const [inf] = emit({ codec: 'hevc', bitDepth: 8, hdr: null });
    expect(inf).toContain('CODECS="hvc1.1.6.');
    expect(inf).not.toContain('VIDEO-RANGE');
  });

  it('AV1 → av01 codec string at its bit depth', () => {
    expect(emit({ codec: 'av1', bitDepth: 10, hdr: 'HDR10' }, 'PQ')[0]).toMatch(
      /CODECS="av01\.0\.\d+M\.10/,
    );
    expect(emit({ codec: 'av1', bitDepth: 8, hdr: null })[0]).toMatch(
      /CODECS="av01\.0\.\d+M\.08/,
    );
  });

  it('H.264 → avc1 codec string', () => {
    expect(emit({ codec: 'h264', bitDepth: 8, hdr: null })[0]).toContain(
      'CODECS="avc1.',
    );
  });

  it('emits a STREAM-INF + URI pair per rung', () => {
    const lines = emit({ codec: 'h264', bitDepth: 8, hdr: null });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^#EXT-X-STREAM-INF:/);
    expect(lines[1]).toBe('/api/stream/1/1080p/index.m3u8');
  });
});

describe('emitAudioRenditions', () => {
  it('emits one EXT-X-MEDIA per stream with the right CHANNELS', () => {
    const lines: string[] = [];
    emitAudioRenditions(
      lines,
      [
        { language: 'eng', channels: 6 },
        { language: 'fre', channels: 2 },
      ],
      0,
      'eac3', // copy/eac3 keeps the source layout
      1,
      '',
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('DEFAULT=YES');
    expect(lines[0]).toContain('CHANNELS="6"');
    expect(lines[1]).toContain('DEFAULT=NO');
    expect(lines[1]).toContain('CHANNELS="2"');
  });
});

describe('buildUniqueAudioNames', () => {
  it('disambiguates duplicate display names with #2, #3', () => {
    expect(
      buildUniqueAudioNames([{ language: 'und' }, { language: 'und' }]),
    ).toEqual(['und', 'und #2']);
  });
});
