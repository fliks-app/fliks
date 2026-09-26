import { StreamBuilderService } from './stream-builder.service';
import type { DeviceProfileDto } from './dto/device-profile.dto';
import type { PlaybackInfoResponse } from './dto/playback-info.dto';

const svc = () =>
  new StreamBuilderService(
    { getDetectedHwAccel: () => 'none' } as never,
    {
      getAutoCropEnabled: () => false,
      getTonemapAlgo: () => 'auto',
      getSegmentDuration: () => 3,
    } as never,
  );

type Track = {
  codec: string;
  channels?: number;
  startTimeSeconds?: number;
  endSeconds?: number;
  language?: string;
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
  svc().evaluate(
    file(audio, opts.ext),
    p,
    '',
    undefined,
    opts.quality,
    'directplay',
    opts.pick,
  ).response;

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
      bitrateBps: 640_000,
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
      bitrateBps: 576_000,
    });
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
    expect(ts.audioPlan).toEqual({ mode: 'copy', codec: 'aac' });
  });

  it('decides the inline output on the real mux: MPEG-TS keeps an offset copy', () => {
    const r = evaluate(
      [{ codec: 'ac3', channels: 6, startTimeSeconds: 0.3 }],
      profile(['ac3'], { useTsOnSingleAudio: true }),
    );
    expect(r.playMethod).toBe('DirectStream');
    expect(r.audioPlan).toEqual({ mode: 'copy', codec: 'ac3' });
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

  it('falls back to the first track for an index outside the file', () => {
    expect(evaluate(multi, tv, { pick: 5 }).source.audioCodec).toBe('aac');
  });

  it('leaves Direct Play for a pick the player cannot switch to in the raw file', () => {
    const twoAac: Track[] = [
      { codec: 'aac', language: 'eng' },
      { codec: 'aac', language: 'fre' },
    ];
    const noSwitch = profile(['aac'], { switchesDirectPlayAudio: false });
    expect(evaluate(twoAac, noSwitch, { ext: '.mp4' }).playMethod).toBe(
      'DirectPlay',
    );
    const picked = evaluate(twoAac, noSwitch, { ext: '.mp4', pick: 1 });
    expect(picked.playMethod).toBe('DirectStream');
    expect(flags(picked)).toContain('ClientCannotSwitchAudio');
    expect(
      evaluate(twoAac, profile(['aac']), { ext: '.mp4', pick: 1 }).playMethod,
    ).toBe('DirectPlay');
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

  it('leaves a muxed single track alone, whose segments the video carries', () => {
    const r = evaluate([{ codec: 'aac', endSeconds: 15 }], tv);
    expect(r.audioPlan).toEqual({ mode: 'copy', codec: 'aac' });
  });
});
