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

describe('generateMasterPlaylist: trick-play rendition', () => {
  const master = (iFrameTrickPlaySegmentSeconds?: number) =>
    generateMasterPlaylist({
      mediaFileId: 7,
      sourceWidth: 3840,
      sourceHeight: 2160,
      tokenParam: '?token=t',
      sourceFrameRate: 24,
      iFrameTrickPlaySegmentSeconds,
    });

  it('stays out of the master unless the client asked for it', () => {
    expect(master()).not.toContain('EXT-X-I-FRAME-STREAM-INF');
  });

  it('points at the I-frame playlist with the capped resolution', () => {
    const line = master(4)
      .split('\n')
      .find((l) => l.startsWith('#EXT-X-I-FRAME-STREAM-INF'))!;
    expect(line).toContain('RESOLUTION=1280x720');
    expect(line).toContain('CODECS="avc1.4d401f"');
    expect(line).toContain('URI="/api/stream/7/iframe/index.m3u8?token=t"');
  });

  it('rides the HDR ladder too, since AVPlay needs it whatever the variant', () => {
    const hdr = generateMasterPlaylist({
      mediaFileId: 7,
      sourceWidth: 3840,
      sourceHeight: 2160,
      tokenParam: '',
      sourceFrameRate: 24,
      hdrPassThrough: { hdrFormat: 'HDR10', hdrVariant: HEVC_HDR10 },
      canEmitHdrLadder: true,
      iFrameTrickPlaySegmentSeconds: 4,
    });
    expect(hdr).toContain('#EXT-X-I-FRAME-STREAM-INF');
  });
});

describe('generateMasterPlaylist — remux variant (copy path)', () => {
  const remuxMaster = (
    opts: Partial<Parameters<typeof generateMasterPlaylist>[0]> = {},
  ): string =>
    generateMasterPlaylist({
      mediaFileId: 26,
      sourceWidth: 1920,
      sourceHeight: 800,
      tokenParam: '?token=t',
      includeRemux: true,
      sourceBitrate: 10_000_000,
      sourceFrameRate: 23.976,
      remuxCodecs: 'avc1.640029',
      outputAudioCodec: 'eac3',
      ...opts,
    });

  it('publishes the copy variant alone, so ABR has no rung to flip to', () => {
    const m = remuxMaster();
    const lines = streamInfLines(m);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NAME="remux"');
    expect(m).toContain('/api/stream/26/remux/index.m3u8?token=t');
    // No transcode rung alongside it: that pairing is what made ExoPlayer
    // ABR-downgrade and respawn ffmpeg.
    expect(m).not.toMatch(/\/api\/stream\/26\/(eco-)?\d+p\/index\.m3u8/);
  });

  it('declares the probed source CODECS, never a rung-derived level', () => {
    const lines = streamInfLines(remuxMaster());
    // L4.1 (29) as probed. The rung arithmetic would say L4.0 (28) for
    // 1920x800 — under-declaring is the Safari/Cast reject class.
    expect(lines[0]).toContain('CODECS="avc1.640029,ec-3"');
    expect(lines[0]).not.toContain('avc1.640028');
  });

  it('omits CODECS rather than guessing when the source mapping is unknown', () => {
    const lines = streamInfLines(remuxMaster({ remuxCodecs: null }));
    expect(lines[0]).not.toContain('CODECS=');
  });

  it('prefers the container total over summed per-stream bitrates', () => {
    // MKV with no per-stream video bitrate: sourceBitrate collapses to the
    // audio track (768 kbps) and would advertise a 1080p copy as 1 Mbps.
    const line = streamInfLines(
      remuxMaster({ sourceBitrate: 768_000, remuxBandwidthBps: 9_700_000 }),
    )[0];
    expect(line).toContain('AVERAGE-BANDWIDTH=9700000');
  });

  it('carries the source resolution and a peak BANDWIDTH above the average', () => {
    const line = streamInfLines(remuxMaster())[0];
    expect(line).toContain('RESOLUTION=1920x800');
    expect(line).toContain('AVERAGE-BANDWIDTH=10000000');
    expect(line).toContain('BANDWIDTH=15000000');
  });

  it('falls back to the ladder when the user pinned a rung', () => {
    const m = remuxMaster({ onlyQuality: '720p' });
    const lines = streamInfLines(m);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NAME="720p"');
    expect(m).not.toContain('/remux/index.m3u8');
  });

  it('keeps the ladder when the decision was not a copy', () => {
    const m = remuxMaster({ includeRemux: false });
    expect(m).not.toContain('/remux/index.m3u8');
    expect(streamInfLines(m).length).toBeGreaterThan(1);
  });
});

describe('generateMasterPlaylist: HDR remux variant (copy path)', () => {
  const hdrRemuxMaster = (
    opts: Partial<Parameters<typeof generateMasterPlaylist>[0]> = {},
  ): string =>
    generateMasterPlaylist({
      mediaFileId: 26,
      sourceWidth: 3840,
      sourceHeight: 2160,
      tokenParam: '?token=t',
      includeRemux: true,
      sourceBitrate: 40_000_000,
      sourceFrameRate: 23.976,
      remuxCodecs: 'hvc1.2.4.L153.B0',
      outputAudioCodec: 'eac3',
      hdrPassThrough: { hdrFormat: 'HDR10', hdrVariant: HEVC_HDR10 },
      canEmitHdrLadder: true,
      ...opts,
    });

  it('publishes the copy variant alone, not the HDR transcode ladder', () => {
    const m = hdrRemuxMaster();
    const lines = streamInfLines(m);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NAME="remux"');
    expect(m).toContain('/api/stream/26/remux/index.m3u8?token=t');
    expect(m).not.toMatch(/\/api\/stream\/26\/(eco-)?\d+p-hdr\/index\.m3u8/);
  });

  it('declares the probed source CODECS, never a rung-derived one', () => {
    const lines = streamInfLines(hdrRemuxMaster());
    expect(lines[0]).toContain('CODECS="hvc1.2.4.L153.B0,ec-3"');
  });

  it('carries VIDEO-RANGE and the source resolution', () => {
    const line = streamInfLines(hdrRemuxMaster())[0];
    expect(line).toContain('VIDEO-RANGE=PQ');
    expect(line).toContain('RESOLUTION=3840x2160');
  });

  it('is published even when the host has no HDR encoder (copy needs none)', () => {
    const m = hdrRemuxMaster({ canEmitHdrLadder: false });
    const lines = streamInfLines(m);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NAME="remux"');
  });

  it('falls back to the HDR ladder when the user pinned a rung', () => {
    const m = hdrRemuxMaster({ onlyQuality: '1080p' });
    const lines = streamInfLines(m);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NAME="1080p-hdr"');
    expect(m).not.toContain('/remux/index.m3u8');
  });
});
