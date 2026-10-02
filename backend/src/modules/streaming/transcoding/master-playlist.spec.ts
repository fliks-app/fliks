import { generateMasterPlaylist, pinnedRungName } from './master-playlist';
import type { CodecVariant } from './codec/types';
import type { AudioPlan } from './audio-encode';

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
      audioStreams: [{ channels: 8 }, { channels: 8 }],
      audioPlans: [
        { mode: 'transcode', codec: 'eac3', channels: 6 },
        { mode: 'copy', codec: 'eac3', channels: 8 },
      ],
    });
    const media = mediaLines(m);
    expect(media[0]).toContain('CHANNELS="6"');
    expect(media[1]).toContain('CHANNELS="8"');
  });

  it('declares the resolved output channels on the HDR ladder too', () => {
    const m = generateMasterPlaylist({
      mediaFileId: 1,
      sourceWidth: 3840,
      sourceHeight: 2160,
      tokenParam: '',
      hdrPassThrough: { hdrFormat: 'HDR10', hdrVariant: HEVC_HDR10 },
      canEmitHdrLadder: true,
      audioStreams: [{ channels: 6 }, { channels: 2 }],
      audioPlans: [
        { mode: 'transcode', codec: 'aac', channels: 6 },
        { mode: 'transcode', codec: 'aac', channels: 2 },
      ],
    });
    const media = mediaLines(m);
    expect(media[0]).toContain('CHANNELS="6"');
    expect(media[1]).toContain('CHANNELS="2"');
    expect(streamInfLines(m).every((l) => l.includes('AUDIO="audio"'))).toBe(
      true,
    );
  });

  it('falls back to the codec-derived count when output channels are absent', () => {
    const m = generateMasterPlaylist({
      mediaFileId: 1,
      sourceWidth: 1920,
      sourceHeight: 1080,
      tokenParam: '',
      audioPlans: [{ mode: 'copy', codec: 'eac3' }],
      audioStreams: [{ channels: 6 }],
    });
    expect(mediaLines(m)[0]).toContain('CHANNELS="6"');
  });
});

describe('generateMasterPlaylist — dedupesAudioByLanguage', () => {
  const mediaLines = (m: string): string[] =>
    m.split('\n').filter((l) => l.startsWith('#EXT-X-MEDIA:TYPE=AUDIO'));
  const uri = (l: string): string => (l.match(/\/audio\/(\d+)\//) || [])[1];
  // Measured shape on webOS: eng/eng/hin surfaces two tracks, so the second
  // English is only reachable if the group publishes it instead of the first.
  const base = {
    mediaFileId: 1,
    sourceWidth: 1920,
    sourceHeight: 1080,
    tokenParam: '',
    audioStreams: [
      { channels: 6, language: 'eng' },
      { channels: 6, language: 'eng' },
      { channels: 2, language: 'hin' },
    ],
  };

  it('keeps one rendition per language, the picked track winning its own', () => {
    const media = mediaLines(
      generateMasterPlaylist({
        ...base,
        defaultAudioIndex: 1,
        dedupesAudioByLanguage: true,
      }),
    );
    expect(media.map(uri)).toEqual(['1', '2']);
    expect(media[0]).toContain('DEFAULT=YES');
  });

  it('keeps the other languages when the picked track is not theirs', () => {
    const media = mediaLines(
      generateMasterPlaylist({
        ...base,
        defaultAudioIndex: 2,
        dedupesAudioByLanguage: true,
      }),
    );
    // hin picked, and English still reachable through its first rendition.
    expect(media.map(uri)).toEqual(['0', '2']);
  });

  it('never drops a rendition when each language is already unique', () => {
    const twoLangs = {
      ...base,
      audioStreams: [
        { channels: 6, language: 'fre' },
        { channels: 6, language: 'eng' },
      ],
      defaultAudioIndex: 1,
    };
    expect(
      mediaLines(generateMasterPlaylist({ ...twoLangs, dedupesAudioByLanguage: true })),
    ).toHaveLength(2);
  });

  it('publishes every rendition when unset', () => {
    expect(mediaLines(generateMasterPlaylist({ ...base, defaultAudioIndex: 1 }))).toHaveLength(3);
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

  it('a pin above the source resolves to the nearest rung of its class', () => {
    const m = generateMasterPlaylist({ ...base, supportsAbr: false, onlyQuality: 'eco-2160p' });
    expect(streamInfLines(m)).toHaveLength(1);
    expect(m).toContain('/eco-1080p/');
  });

  it('pinnedRungName matches the rung the master publishes', () => {
    expect(pinnedRungName('eco-2160p', 1920, 1080, false, 'desktop')).toBe('eco-1080p');
    expect(pinnedRungName('1080p', 3840, 2160, true, 'desktop')).toBe('1080p-hdr');
  });
});

describe('generateMasterPlaylist — audio bitrate in BANDWIDTH', () => {
  const maxAvgBandwidth = (m: string): number =>
    Math.max(
      ...[...m.matchAll(/AVERAGE-BANDWIDTH=(\d+)/g)].map((x) => Number(x[1])),
    );

  const base = {
    mediaFileId: 1,
    sourceWidth: 1920,
    sourceHeight: 1080,
    tokenParam: '',
  };
  const eac3: AudioPlan = { mode: 'transcode', codec: 'eac3', channels: 6 };
  const aac: AudioPlan = { mode: 'transcode', codec: 'aac', channels: 2 };

  it('folds the encode bitrate of the top rung into AVERAGE-BANDWIDTH', () => {
    const hi = generateMasterPlaylist({ ...base, audioPlans: [eac3] });
    const lo = generateMasterPlaylist({ ...base, audioPlans: [aac] });
    // Same video rungs; only the audio differs: 5.1 takes three 192k pairs.
    expect(maxAvgBandwidth(hi) - maxAvgBandwidth(lo)).toBe(384_000);
  });

  it('declares each rung its own audio bitrate, a copy its source one', () => {
    const avg = (m: string, rung: string) =>
      Number(
        new RegExp(`AVERAGE-BANDWIDTH=(\\d+),[^\\n]*NAME="${rung}"`).exec(
          m,
        )![1],
      );
    const enc = generateMasterPlaylist({ ...base, audioPlans: [eac3] });
    const none = generateMasterPlaylist({
      ...base,
      audioStreams: [],
    });
    // 480p's 96k stereo budget: 288k of E-AC-3 5.1, not the top rung's 576k.
    expect(avg(enc, '480p') - avg(none, '480p')).toBe(288_000);
    const atmos = generateMasterPlaylist({
      ...base,
      audioPlans: [
        { mode: 'copy', codec: 'eac3', channels: 6, bitrateBps: 768_000 },
      ],
    });
    expect(avg(atmos, '480p') - avg(none, '480p')).toBe(768_000);
  });

  it('counts the heaviest rendition of a group', () => {
    const group = generateMasterPlaylist({
      ...base,
      audioStreams: [{ channels: 2 }, { channels: 6 }],
      audioPlans: [aac, eac3],
    });
    expect(maxAvgBandwidth(group)).toBe(
      maxAvgBandwidth(generateMasterPlaylist({ ...base, audioPlans: [eac3] })),
    );
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
      formatBitRate: 10_000_000,
      sourceFrameRate: 23.976,
      remuxCodecs: 'avc1.640029',
      audioPlans: [{ mode: 'copy', codec: 'eac3' }],
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

  it('declares the coded size of the copy, not the crop the ladder applies', () => {
    const lines = streamInfLines(remuxMaster({ remuxWidth: 1920, remuxHeight: 1080 }));
    expect(lines[0]).toContain('RESOLUTION=1920x1080');
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

  it('falls back to the container total alone when no per-stream video bitrate is known', () => {
    const line = streamInfLines(remuxMaster({ formatBitRate: 9_700_000 }))[0];
    expect(line).toContain('AVERAGE-BANDWIDTH=9700000');
  });

  it('carries the source resolution, with no video-only figure to split from', () => {
    const line = streamInfLines(remuxMaster())[0];
    expect(line).toContain('RESOLUTION=1920x800');
    // No sourceVideoBitrateBps here: the container total stands in for both,
    // same as before, never inflated by a flat multiplier.
    expect(line).toContain('AVERAGE-BANDWIDTH=10000000');
    expect(line).toContain('BANDWIDTH=10000000');
  });

  it('peaks BANDWIDTH at the video bitrate plus the largest audio rendition', () => {
    // 9 Mbps video + the eac3 copy's 192 kbps stereo reference (no probed
    // bitrate on the plan) = 9,192,000, identical for both attributes.
    const line = streamInfLines(
      remuxMaster({ sourceVideoBitrateBps: 9_000_000 }),
    )[0];
    expect(line).toContain('BANDWIDTH=9192000,AVERAGE-BANDWIDTH=9192000');
  });

  it('never counts every audio track, only the largest rendition', () => {
    const line = streamInfLines(
      remuxMaster({
        sourceVideoBitrateBps: 9_000_000,
        audioPlans: [
          { mode: 'copy', codec: 'eac3', bitrateBps: 192_000 },
          { mode: 'copy', codec: 'ac3', bitrateBps: 640_000 },
        ] as AudioPlan[],
      }),
    )[0];
    // Peak of the two renditions (640k), not their sum (832k).
    expect(line).toContain('BANDWIDTH=9640000,AVERAGE-BANDWIDTH=9640000');
  });

  it('never adds a phantom audio rendition to BANDWIDTH for an audio-less source', () => {
    // audioStreams: [] signals no-audio; a stray `audioPlans` entry (the
    // placeholder plan a no-audio session still carries) must not count.
    const line = streamInfLines(
      remuxMaster({
        sourceVideoBitrateBps: 9_000_000,
        audioStreams: [],
        audioPlans: [{ mode: 'copy', codec: '' }] as AudioPlan[],
      }),
    )[0];
    expect(line).toContain('BANDWIDTH=9000000,AVERAGE-BANDWIDTH=9000000');
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
      formatBitRate: 40_000_000,
      sourceFrameRate: 23.976,
      remuxCodecs: 'hvc1.2.4.L153.B0',
      audioPlans: [{ mode: 'copy', codec: 'eac3' }],
      hdrPassThrough: { hdrFormat: 'HDR10', hdrVariant: HEVC_HDR10 },
      canEmitHdrLadder: true,
      sourceHdrFormat: 'HDR10',
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

  it('carries VIDEO-RANGE from sourceHdrFormat alone, with no hdrPassThrough', () => {
    const line = streamInfLines(
      hdrRemuxMaster({ hdrPassThrough: undefined, canEmitHdrLadder: false }),
    )[0];
    expect(line).toContain('VIDEO-RANGE=PQ');
  });

  it('adds SUPPLEMENTAL-CODECS for a Dolby Vision P8.1 remux, alongside VIDEO-RANGE=PQ', () => {
    const line = streamInfLines(
      hdrRemuxMaster({ remuxSupplementalCodecs: 'dvh1.08.06/db1p' }),
    )[0];
    expect(line).toContain('CODECS="hvc1.2.4.L153.B0,ec-3"');
    expect(line).toContain('SUPPLEMENTAL-CODECS="dvh1.08.06/db1p"');
    expect(line).toContain('VIDEO-RANGE=PQ');
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
