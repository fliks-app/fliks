import { mpvAudioCodecs, mpvVideo } from './desktop-mpv';

describe('mpvVideo', () => {
  it('lists the codecs and demuxers mpv names, with the profile aliases', () => {
    const v = mpvVideo(['h264', 'hevc', 'vc1', 'unknown'], ['matroska', 'webm', 'mov', 'mpegts']);
    expect(v.videoCodecs).toEqual(['h264', 'avc1', 'hevc', 'h265', 'hvc1', 'vc1']);
    expect(v.containers).toEqual(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'ts', 'm2ts', 'mts']);
    expect(v.codecConditions.map((c) => c.codec)).toEqual(['h264', 'hevc']);
  });

  it('claims nothing mpv lacks', () => {
    expect(mpvVideo([], [])).toEqual({ containers: [], videoCodecs: [], codecConditions: [] });
  });
});

describe('mpvAudioCodecs', () => {
  it('keeps the codecs mpv decodes', () => {
    expect(mpvAudioCodecs(['aac', 'dts', 'h264', 'truehd'])).toEqual(['aac', 'dts', 'truehd']);
  });
});
