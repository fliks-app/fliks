import { audioStartAlignFilter, perStreamAudioArgs } from './ffmpeg-args';
import type { AudioStreamMeta } from './types';

const enc = (alignStartSeconds: number, useTs = false) => ({
  stereoBitrate: '128k',
  alignStartSeconds,
  useTs,
});

/**
 * The multi-audio `var_stream_map` output muxes the video at stream 0, so the
 * per-rendition channel option must use the audio-relative specifier
 * (`-ac:a:i`). A bare `-ac:i` targets the wrong output stream and leaves the
 * last rendition at its source channel count — the master then declares
 * CHANNELS="2"/AAC-LC while shipping a 5.1 init, and the browser rejects the
 * append (Shaka error 3014) on every non-default language.
 */
describe('perStreamAudioArgs', () => {
  const twoSurround: AudioStreamMeta[] = [
    { language: 'ita', channels: 6 },
    { language: 'eng', channels: 6 },
  ];

  it('downmixes every AAC rendition with an audio-relative -ac:a:i', () => {
    const args = perStreamAudioArgs(
      twoSurround,
      [
        { copy: false, outputCodec: 'aac', outputChannels: 2 },
        { copy: false, outputCodec: 'aac', outputChannels: 2 },
      ],
      enc(0),
    );

    const joined = args!.join(' ');
    expect(joined).toContain('-ac:a:0 2');
    expect(joined).toContain('-ac:a:1 2');
    // Never the bare specifier: it would hit the video at stream 0 / the wrong
    // audio rendition.
    expect(args).not.toContain('-ac:0');
    expect(args).not.toContain('-ac:1');
  });

  it('uses -ac:a:i for the EAC-3 surround downmix too', () => {
    const args = perStreamAudioArgs(
      twoSurround,
      [
        { copy: false, outputCodec: 'eac3', outputChannels: 6 },
        { copy: false, outputCodec: 'eac3', outputChannels: 6 },
      ],
      enc(0),
    );

    const joined = args!.join(' ');
    expect(joined).toContain('-c:a:0 eac3');
    expect(joined).toContain('-ac:a:0 6');
    expect(joined).toContain('-ac:a:1 6');
    // Surround bitrate is the named constant (640k), pinned here so it can't
    // drift from the master-playlist BANDWIDTH that honours the same value.
    expect(joined).toContain('-b:a:0 640k');
  });

  it('copies a fitting rendition without a channel arg', () => {
    const args = perStreamAudioArgs(
      twoSurround,
      [
        { copy: true, outputCodec: 'eac3' },
        { copy: false, outputCodec: 'aac', outputChannels: 2 },
      ],
      enc(0),
    );

    expect(args).toEqual([
      '-c:a:0',
      'copy',
      '-c:a:1',
      'aac',
      '-b:a:1',
      '128k',
      '-ac:a:1',
      '2',
      '-filter:a:1',
      'asetpts=PTS-0/TB,aresample=async=1:first_pts=0,asetpts=PTS+0/TB',
    ]);
  });

  it('keeps the planned channels of an AAC rendition re-encoded only for its offset', () => {
    const args = perStreamAudioArgs(
      twoSurround,
      [
        { copy: false, outputCodec: 'aac', outputChannels: 6 },
        { copy: false, outputCodec: 'aac' },
      ],
      enc(0),
    );
    const joined = args!.join(' ');
    expect(joined).toContain('-ac:a:0 6');
    expect(joined).toContain('-ac:a:1 2');
  });

  it('aligns every re-encoded rendition to the run start, never a copied one', () => {
    const args = perStreamAudioArgs(
      twoSurround,
      [
        { copy: true, outputCodec: 'opus' },
        { copy: false, outputCodec: 'opus', outputChannels: 6 },
      ],
      enc(11.8),
    );
    expect(args).not.toContain('-filter:a:0');
    expect(args!.join(' ')).toContain(
      '-filter:a:1 asetpts=PTS-11.8/TB,aresample=async=1:first_pts=0,asetpts=PTS+11.8/TB',
    );
  });

  it('returns null when the plan count does not match the stream count', () => {
    expect(
      perStreamAudioArgs(
        twoSurround,
        [{ copy: false, outputCodec: 'aac', outputChannels: 2 }],
        enc(0),
      ),
    ).toBeNull();
    expect(perStreamAudioArgs(twoSurround, undefined, enc(0))).toBeNull();
  });
});

describe('perStreamAudioArgs — codec policy', () => {
  const one: AudioStreamMeta[] = [{ language: 'eng', channels: 6 }];

  it('turns a copied AAC into raw AAC for fMP4, never for MPEG-TS', () => {
    const plan = [{ copy: true, outputCodec: 'aac' }];
    expect(perStreamAudioArgs(one, plan, enc(0))).toEqual([
      '-c:a:0',
      'copy',
      '-bsf:a:0',
      'aac_adtstoasc',
    ]);
    expect(perStreamAudioArgs(one, plan, enc(0, true))).toEqual([
      '-c:a:0',
      'copy',
    ]);
    expect(
      perStreamAudioArgs(one, [{ copy: true, outputCodec: 'eac3' }], enc(0)),
    ).toEqual(['-c:a:0', 'copy']);
  });

  it('scales the stereo rung bitrate with the channel count', () => {
    const at = (outputCodec: string, outputChannels: number) => {
      const args = perStreamAudioArgs(
        one,
        [{ copy: false, outputCodec, outputChannels }],
        enc(0),
      )!;
      return args[args.indexOf('-b:a:0') + 1];
    };
    expect(at('aac', 1)).toBe('128k');
    expect(at('aac', 2)).toBe('128k');
    expect(at('aac', 6)).toBe('384k');
    expect(at('aac', 8)).toBe('512k');
    expect(at('opus', 6)).toBe('384k');
    expect(at('eac3', 2)).toBe('640k');
    expect(at('ac3', 6)).toBe('640k');
  });

  it('pads an encoded rendition up to the video end', () => {
    const args = perStreamAudioArgs(
      one,
      [{ copy: false, outputCodec: 'aac', outputChannels: 2 }],
      { ...enc(12), endSeconds: 40 },
    )!;
    expect(args[args.indexOf('-filter:a:0') + 1]).toBe(
      audioStartAlignFilter(12, 40),
    );
  });

  it('refuses an output codec it has no encoder for', () => {
    expect(() =>
      perStreamAudioArgs(
        one,
        [{ copy: false, outputCodec: 'dts', outputChannels: 6 }],
        enc(0),
      ),
    ).toThrow(/dts/);
  });
});

describe('audioStartAlignFilter', () => {
  it('pads to the end relative to the run start', () => {
    expect(audioStartAlignFilter(12, 40)).toBe(
      'asetpts=PTS-12/TB,aresample=async=1:first_pts=0,apad=whole_dur=28,asetpts=PTS+12/TB',
    );
    expect(audioStartAlignFilter(40, 40)).not.toContain('apad');
  });

  it('shifts by seconds, so the sample rate never enters the filter', () => {
    expect(audioStartAlignFilter(2.8)).toBe(
      'asetpts=PTS-2.8/TB,aresample=async=1:first_pts=0,asetpts=PTS+2.8/TB',
    );
  });

  it('handles a negative start without a double sign', () => {
    expect(audioStartAlignFilter(-0.005)).toBe(
      'asetpts=PTS+0.005/TB,aresample=async=1:first_pts=0,asetpts=PTS-0.005/TB',
    );
  });
});
