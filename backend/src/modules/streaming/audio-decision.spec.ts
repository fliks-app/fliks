import type { DeviceProfileDto } from './dto/device-profile.dto';
import type { PlaybackInfoResponse } from './dto/playback-info.dto';
import { audioOutputBitrateBps } from './transcoding/audio-encode';
import { remuxSegmentGrid } from './transcoding/segment-boundaries';
import { sourceTimeline } from './transcoding/source-timeline';
import { makeStreamBuilder as svc } from './stream-builder.test-helpers';
import type { MediaFileInfo } from '../subtitles/ffprobe.service';

type Track = {
  codec: string;
  channels?: number;
  startTimeSeconds?: number;
  endSeconds?: number;
  language?: string;
  bitRate?: number;
  sampleRate?: number;
};

const profile = (
  audioCodecs: string[],
  extra: Partial<DeviceProfileDto> = {},
): DeviceProfileDto =>
  ({
    directPlayProfiles: [
      { containers: ['mp4'], videoCodecs: ['h264'], audioCodecs },
    ],
    maxAudioChannels: 6,
    ...extra,
  }) as never;

const tv = profile(['aac', 'ac3', 'eac3']);
const browser = profile(['aac', 'opus', 'flac'], { maxAudioChannels: 2 });

const file = (audio: Track[], ext = '.mkv') =>
  ({
    ext,
    absolutePath: `/media/file${ext}`,
    contentType: 'video/x-matroska',
    mediaFile: {
      id: 1,
      streamInfo: {
        video: [
          {
            codec: 'h264',
            width: 1920,
            height: 1080,
            bitRate: 8_000_000,
            frameRate: '24',
            startTimeSeconds: 0,
            endSeconds: 100,
          },
        ],
        audio: audio.map((a, i) => ({
          streamIndex: i + 1,
          channels: 2,
          startTimeSeconds: 0,
          language: 'und',
          ...a,
        })),
        durationSeconds: 100,
      },
    },
  }) as never;

const evaluate = (
  audio: Track[],
  p: DeviceProfileDto,
  opts: { ext?: string; quality?: string; pick?: number } = {},
): PlaybackInfoResponse =>
  svc().evaluate({
    resolved: file(audio, opts.ext),
    profile: p,
    tokenParam: '',
    requestedQuality: opts.quality,
    audioStreamIndex: opts.pick,
    settings: { autoQualityMode: 'directplay' },
  }).response;

const flags = (r: PlaybackInfoResponse) =>
  r.transcodeReasons.map((x) => x.flag);

/** The top-level plan must be the picked track's decision, on either HLS path. */
function expectPlanMatchesTrack(r: PlaybackInfoResponse, pick = 0): void {
  const t = r.audioTracks![pick];
  expect(r.audioCopyStream).toBe(t.copy);
  expect(r.audioPlan.codec).toBe(t.outputCodec);
  if (r.audioPlan.mode === 'transcode') {
    expect(r.audioPlan.channels).toBe(t.outputChannels);
  }
  const audioFlags = flags(r).filter((f) => f.startsWith('Audio'));
  expect(audioFlags).toEqual(t.reasonFlags);
}

describe('StreamBuilderService — one audio decision per track', () => {
  const sources: Track[] = [
    { codec: 'dts', channels: 6 },
    { codec: 'truehd', channels: 8 },
    { codec: 'eac3', channels: 6 },
    { codec: 'eac3', channels: 8, startTimeSeconds: 0.3 },
    { codec: 'ac3', channels: 6 },
    { codec: 'flac', channels: 6 },
    { codec: 'pcm_s24le', channels: 6 },
    { codec: 'mp3', channels: 2 },
    { codec: 'opus', channels: 6 },
    { codec: 'aac', channels: 1 },
    { codec: 'aac', channels: 6, startTimeSeconds: 0.3 },
    { codec: 'aac', channels: 8 },
  ];
  const profiles: Record<string, DeviceProfileDto> = {
    tv,
    browser,
    edge71: profile(['aac', 'ac3', 'eac3', 'opus', 'flac'], {
      maxAudioChannels: 8,
    }),
  };

  for (const [name, p] of Object.entries(profiles)) {
    for (const s of sources) {
      it(`${name}: ${s.codec} ${s.channels}ch — plan equals the track on DirectStream and Transcode`, () => {
        const ds = evaluate([s], p);
        expect(ds.playMethod).toBe('DirectStream');
        expectPlanMatchesTrack(ds);
        const tx = evaluate([s], p, { quality: '720p' });
        expect(tx.playMethod).toBe('Transcode');
        expectPlanMatchesTrack(tx);
      });
    }
  }

  it('keeps DTS surround on a surround device through DirectStream', () => {
    const r = evaluate([{ codec: 'dts', channels: 6 }], tv);
    expect(r.playMethod).toBe('DirectStream');
    expect(r.audioPlan).toEqual({
      mode: 'transcode',
      codec: 'eac3',
      channels: 6,
    });
  });

  it('clamps an E-AC-3 7.1 re-encode to the encoder 5.1 ceiling', () => {
    const r = evaluate(
      [{ codec: 'eac3', channels: 8, startTimeSeconds: 0.3 }],
      profile(['eac3'], { maxAudioChannels: 8 }),
    );
    expect(r.audioPlan).toMatchObject({
      mode: 'transcode',
      codec: 'eac3',
      channels: 6,
    });
    expect(r.audioTracks![0].reasonFlags).toEqual([
      'AudioChannelsNotSupported',
      'AudioStartOffset',
    ]);
  });

  it('scales an AAC surround re-encode bitrate with its channels', () => {
    const r = evaluate(
      [{ codec: 'aac', channels: 6, startTimeSeconds: 0.3 }],
      tv,
    );
    expect(r.audioPlan).toEqual({
      mode: 'transcode',
      codec: 'aac',
      channels: 6,
    });
    expect(audioOutputBitrateBps(r.audioPlan, 192_000)).toBe(576_000);
  });

  it('encodes AAC at the device cap rather than always stereo', () => {
    const chrome51 = profile(['aac'], { maxAudioChannels: 6 });
    expect(
      evaluate([{ codec: 'dts', channels: 6 }], chrome51).audioPlan,
    ).toMatchObject({
      codec: 'aac',
      channels: 6,
    });
    expect(
      evaluate([{ codec: 'aac', channels: 8 }], tv).audioPlan,
    ).toMatchObject({
      codec: 'aac',
      channels: 6,
    });
  });

  it('picks a surround codec only where the device takes 5.1 in it', () => {
    const stereoDolby = profile(['aac', 'eac3'], { maxAudioChannels: 2 });
    expect(
      evaluate([{ codec: 'dts', channels: 6 }], stereoDolby).audioPlan,
    ).toMatchObject({
      codec: 'aac',
      channels: 2,
    });
  });

  it('groups on a surround codec a track already carries, to copy it', () => {
    const tracks: Track[] = [
      { codec: 'truehd', channels: 8 },
      { codec: 'ac3', channels: 6 },
    ];
    const r = evaluate(tracks, tv, { quality: '720p' });
    expect(
      r.audioTracks!.map((t) => `${t.copy ? 'copy' : 'tx'}:${t.outputCodec}`),
    ).toEqual(['tx:ac3', 'copy:ac3']);
    // Not when that track is re-encoded anyway, here to align its offset.
    expect(
      evaluate(
        [
          { codec: 'truehd', channels: 8 },
          { codec: 'ac3', channels: 6, startTimeSeconds: 0.3 },
        ],
        tv,
        { quality: '720p' },
      ).audioTracks!.map((t) => t.outputCodec),
    ).toEqual(['eac3', 'eac3']);
    // With no such track, E-AC-3 still wins over AC-3.
    expect(
      evaluate(
        [
          { codec: 'truehd', channels: 8 },
          { codec: 'dts', channels: 6 },
        ],
        tv,
        {
          quality: '720p',
        },
      ).audioTracks!.map((t) => t.outputCodec),
    ).toEqual(['eac3', 'eac3']);
  });

  it('copies AAC from MPEG-TS once a scan saw its format hold', () => {
    const scanned = (audioConfigChanges: Record<number, boolean> | null) =>
      svc().evaluate({
        resolved: file([{ codec: 'aac', channels: 2 }], '.ts'),
        profile: tv,
        tokenParam: '',
        sourceScan: audioConfigChanges && { keyframes: [], end: 100, audioConfigChanges },
        settings: { autoQualityMode: 'directplay', segmentDuration: 3 },
      }).response;
    expect(scanned({ 1: false }).audioPlan).toEqual({
      mode: 'copy',
      codec: 'aac',
      channels: 2,
    });
    // streamIndex 1: the one track changes, or no scan ran yet.
    expect(flags(scanned({ 1: true }))).toContain('AudioFormatMayChange');
    expect(flags(scanned(null))).toContain('AudioFormatMayChange');
  });

  it('re-encodes AAC from MPEG-TS on fMP4 and copies it into MPEG-TS', () => {
    const fmp4 = evaluate([{ codec: 'aac', channels: 2 }], tv, { ext: '.ts' });
    expect(fmp4.audioPlan.mode).toBe('transcode');
    expect(fmp4.audioTracks![0].reasonFlags).toEqual(['AudioFormatMayChange']);
    const ts = evaluate(
      [{ codec: 'aac', channels: 2 }],
      profile(['aac'], { useTsOnSingleAudio: true }),
      {
        ext: '.ts',
      },
    );
    expect(ts.audioPlan).toEqual({ mode: 'copy', codec: 'aac', channels: 2 });
  });

  it('decides the inline output on the real mux: MPEG-TS keeps an offset copy', () => {
    const r = evaluate(
      [{ codec: 'ac3', channels: 6, startTimeSeconds: 0.3 }],
      profile(['ac3'], { useTsOnSingleAudio: true }),
    );
    // TS mux forces the video onto the transcode ladder (buildRemuxArgs is
    // fMP4-only); the picked track's own copy/transcode decision is unaffected.
    expect(r.playMethod).toBe('Transcode');
    expect(flags(r)).toContain('MuxNotSupported');
    expect(r.audioPlan).toEqual({ mode: 'copy', codec: 'ac3', channels: 6 });
  });

  // useTsOnSingleAudio only forces TS below 2 tracks; a multi-audio Tizen
  // source stays fMP4/EXT-X-MEDIA, the same layout its transcode ladder uses.
  it('allows a multi-audio remux for Tizen, unlike the single-audio TS gate above', () => {
    const r = evaluate(
      [
        { codec: 'ac3', channels: 6, language: 'eng' },
        { codec: 'ac3', channels: 6, language: 'fre' },
      ],
      profile(['ac3'], { useTsOnSingleAudio: true }),
    );
    expect(r.playMethod).toBe('DirectStream');
    expect(flags(r)).not.toContain('MuxNotSupported');
  });

  it('reports a channel overflow as a channel reason, not a codec one', () => {
    const r = evaluate([{ codec: 'aac', channels: 6 }], browser, {
      ext: '.mp4',
    });
    expect(r.playMethod).toBe('DirectStream');
    expect(flags(r)).toContain('AudioChannelsNotSupported');
    expect(flags(r)).not.toContain('AudioCodecNotSupported');
  });
});

describe('StreamBuilderService — picked audio track', () => {
  const multi: Track[] = [
    { codec: 'aac', channels: 2, language: 'eng' },
    { codec: 'dts', channels: 6, language: 'fre' },
  ];

  it('decides the plan on the picked track', () => {
    const r = evaluate(multi, tv, { pick: 1 });
    expect(r.audioPlan).toMatchObject({ codec: 'eac3', channels: 6 });
    expectPlanMatchesTrack(r, 1);
    expect(r.source.audioCodec).toBe('dts');
  });

  it('a multi-audio remux decides the picked track through the group, like every rendition', () => {
    const stereoAc3: Track[] = [
      { codec: 'aac', channels: 2 },
      { codec: 'ac3', channels: 6 },
    ];
    const svcr = svc().evaluate({
      resolved: file(stereoAc3),
      profile: tv,
      tokenParam: '',
      audioStreamIndex: 0,
      settings: { autoQualityMode: 'directplay' },
    });
    const ds = svcr.response;
    expect(ds.playMethod).toBe('DirectStream');
    // The group's shared codec is ac3 (track 1 forces it); the picked track
    // folds into it instead of copying its own AAC, like every rendition.
    expect(ds.audioPlan).toEqual({ mode: 'transcode', codec: 'ac3', channels: 2 });
    expectPlanMatchesTrack(ds, 0);
    expect(svcr.audioPlans.map((p) => `${p.mode}:${p.codec}`)).toEqual([
      'transcode:ac3',
      'copy:ac3',
    ]);
    const tx = evaluate(stereoAc3, tv, { pick: 0, quality: '720p' });
    expect(tx.audioPlan).toMatchObject({ mode: 'transcode', codec: 'ac3' });
  });

  it('peaks the remux master bandwidth at video + the largest rendition, not every track', () => {
    const stereoAc3: Track[] = [
      { codec: 'aac', channels: 2 },
      { codec: 'ac3', channels: 6 },
    ];
    const ds = svc().evaluate({
      resolved: file(stereoAc3),
      profile: tv,
      tokenParam: '',
      audioStreamIndex: 0,
      settings: { autoQualityMode: 'directplay' },
    }).response;
    // 8 Mbps video + the 6ch ac3 rendition's own 576 kbps (the group's other
    // rendition, transcoded stereo ac3, is smaller and never added on top).
    expect(ds.remuxMasterBandwidthBps).toBe(8_576_000);
  });

  it('pads a multi-audio remux track that ends early, its own rendition carrying segments past it', () => {
    // The picked track shares its sibling's group decision, padded the same
    // way: its own playlist also lists segments past the audio's real end.
    const r = evaluate(
      [
        { codec: 'aac', language: 'eng' },
        { codec: 'aac', language: 'fre', endSeconds: 15 },
      ],
      tv,
      { pick: 1 },
    );
    expect(r.audioPlan).toEqual({ mode: 'transcode', codec: 'aac', channels: 2 });
    expect(flags(r)).toContain('AudioEndsEarly');
  });

  it('falls back to the first track for an index outside the file', () => {
    expect(evaluate(multi, tv, { pick: 5 }).source.audioCodec).toBe('aac');
  });

  it('leaves Direct Play for a pick the player cannot switch to in the raw file', () => {
    const twoAac: Track[] = [
      { codec: 'aac', language: 'eng' },
      { codec: 'aac', language: 'fre' },
    ];
    const noSwitch = profile(['aac'], { switchesDirectPlayAudio: false });
    const first = evaluate(twoAac, noSwitch, { ext: '.mp4' });
    expect(first.playMethod).toBe('DirectStream');
    expect(flags(first)).toContain('ClientCannotSwitchAudio');
    const picked = evaluate(twoAac, noSwitch, { ext: '.mp4', pick: 1 });
    expect(picked.playMethod).toBe('DirectStream');
    expect(flags(picked)).toContain('ClientCannotSwitchAudio');
    expect(
      evaluate(twoAac, profile(['aac']), { ext: '.mp4', pick: 1 }).playMethod,
    ).toBe('DirectPlay');
  });

  it('keeps Direct Play when a no-switch client has nothing to switch', () => {
    const noSwitch = profile(['aac'], { switchesDirectPlayAudio: false });
    expect(evaluate([{ codec: 'aac' }], noSwitch, { ext: '.mp4' }).playMethod).toBe('DirectPlay');
  });

  it('leaves Direct Play for a second same-language track an engine folds away', () => {
    const tracks: Track[] = [
      { codec: 'aac', language: 'eng' },
      { codec: 'aac', language: 'eng' },
      { codec: 'aac', language: 'fre' },
    ];
    const folding = profile(['aac'], { dedupesAudioByLanguage: true });
    expect(evaluate(tracks, folding, { ext: '.mp4', pick: 1 }).playMethod).toBe('DirectStream');
    expect(evaluate(tracks, folding, { ext: '.mp4', pick: 2 }).playMethod).toBe('DirectPlay');
  });
});

describe('StreamBuilderService — audio that ends early', () => {
  // 100 s of video on a 3 s grid: the last segment starts at 99 s.
  const pair = (endSeconds: number): Track[] => [
    { codec: 'aac', language: 'eng' },
    { codec: 'aac', language: 'fre', endSeconds },
  ];

  it('pads a separate rendition that stops before the last video segment', () => {
    const t = evaluate(pair(15), tv).audioTracks![1];
    expect(t.copy).toBe(false);
    expect(t.reasonFlags).toEqual(['AudioEndsEarly']);
  });

  it('copies a rendition that reaches the last video segment', () => {
    expect(evaluate(pair(99.5), tv).audioTracks![1].copy).toBe(true);
  });

  it('judges a remux against the keyframe grid it is cut on', () => {
    // Keyframes every 10 s: the remux's last segment starts at 90 s, not 99 s.
    const scan = {
      keyframes: Array.from({ length: 10 }, (_, i) => ({ pts: i * 10, dts: i * 10 })),
      end: 100,
      audioConfigChanges: {},
    };
    const f = file(pair(95));
    const streamInfo = (f as { mediaFile: { streamInfo: MediaFileInfo } }).mediaFile.streamInfo;
    // Same grid the controller would freeze and serve, fed back in like it does.
    const { origin } = sourceTimeline(streamInfo, (f as { absolutePath: string }).absolutePath);
    const grid = remuxSegmentGrid(scan, origin, 3, streamInfo.video![0].frameRate);
    const r = svc().evaluate({
      resolved: f,
      profile: tv,
      tokenParam: '',
      sourceScan: scan,
      remuxGrid: grid,
      settings: { autoQualityMode: 'directplay', segmentDuration: 3 },
    }).response;
    expect(r.playMethod).toBe('DirectStream');
    expect(r.audioTracks![1].copy).toBe(true);
  });

  it('never derives its own grid from scan, only the frozen grid it is handed decides', () => {
    // Same scan as above, but nothing frozen and passed in: falls back to the
    // plain (ungridded) segment length instead of quietly recomputing one from
    // scan, so this decision can never drift from what remuxSegmentGrid served.
    const scan = {
      keyframes: Array.from({ length: 10 }, (_, i) => ({ pts: i * 10, dts: i * 10 })),
      end: 100,
      audioConfigChanges: {},
    };
    const r = svc().evaluate({
      resolved: file(pair(95)),
      profile: tv,
      tokenParam: '',
      sourceScan: scan,
      settings: { autoQualityMode: 'directplay', segmentDuration: 3 },
    }).response;
    expect(r.audioTracks![1].copy).toBe(false);
    expect(r.audioTracks![1].reasonFlags).toEqual(['AudioEndsEarly']);
  });

  it('leaves a muxed single track alone, whose segments the video carries', () => {
    const r = evaluate([{ codec: 'aac', endSeconds: 15 }], tv);
    expect(r.audioPlan).toEqual({ mode: 'copy', codec: 'aac', channels: 2 });
  });
});

describe('StreamBuilderService: no audio stream', () => {
  it('direct plays a no-audio source the client can otherwise direct play', () => {
    const r = evaluate([], tv, { ext: '.mp4' });
    expect(r.playMethod).toBe('DirectPlay');
    expect(flags(r).some((f) => f.startsWith('Audio'))).toBe(false);
    expect(r.audioPlan).toEqual({ mode: 'copy', codec: '' });
    expect(r.audioCopyStream).toBe(true);
    expect(r.audioTracks).toEqual([]);
  });

  it('remuxes a no-audio source with no audio transcode reason when video forces it', () => {
    const r = evaluate([], tv, { ext: '.mkv' });
    expect(r.playMethod).toBe('DirectStream');
    expect(flags(r).some((f) => f.startsWith('Audio'))).toBe(false);
    expect(r.audioPlan).toEqual({ mode: 'copy', codec: '' });
    expect(r.outputAudioCodec).toBe('');
  });
});

describe('StreamBuilderService - audio track bitrate/sample rate', () => {
  it('reports the source values for a copied track', () => {
    const r = evaluate(
      [{ codec: 'aac', channels: 2, bitRate: 128_000, sampleRate: 44_100 }],
      tv,
    );
    expect(r.audioTracks![0]).toMatchObject({
      copy: true,
      bitrateBps: 128_000,
      sampleRate: 44_100,
    });
  });

  it('reports the negotiated rung encode target for a transcoded track', () => {
    const r = evaluate([{ codec: 'dts', channels: 6 }], tv);
    expect(r.audioTracks![0]).toMatchObject({
      copy: false,
      outputCodec: 'eac3',
      bitrateBps: audioOutputBitrateBps(
        { mode: 'transcode', codec: 'eac3', channels: 6 },
        192_000,
      ),
      sampleRate: 48_000,
    });
  });
});
