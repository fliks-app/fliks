import { perStreamAudioArgs } from './ffmpeg-args';
import type { AudioStreamMeta } from './types';

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
      '128k',
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
      '128k',
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
      '128k',
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
    ]);
  });

  it('returns null when the plan count does not match the stream count', () => {
    expect(
      perStreamAudioArgs(
        twoSurround,
        [{ copy: false, outputCodec: 'aac', outputChannels: 2 }],
        '128k',
      ),
    ).toBeNull();
    expect(perStreamAudioArgs(twoSurround, undefined, '128k')).toBeNull();
  });
});
