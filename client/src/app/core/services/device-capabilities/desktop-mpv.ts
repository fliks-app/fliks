import type { CodecCondition } from '../browser-device-profile.service';
import type { WebVideo } from './web-video';

/** Names asked of mpv's lists, in the server's vocabulary: a video codec by ffmpeg name, with the aliases the profile also carries. */
const VIDEO_CODECS: ReadonlyArray<[decoder: string, names: string[]]> = [
  ['h264', ['h264', 'avc1']],
  ['hevc', ['hevc', 'h265', 'hvc1']],
  ['av1', ['av1']],
  ['vp9', ['vp9']],
  ['vp8', ['vp8']],
  ['mpeg1video', ['mpeg1video']],
  ['mpeg2video', ['mpeg2video']],
  ['mpeg4', ['mpeg4']],
  ['msmpeg4v3', ['msmpeg4v3']],
  ['vc1', ['vc1']],
  ['wmv3', ['wmv3']],
  ['theora', ['theora']],
];

const AUDIO_CODECS = [
  'aac', 'ac3', 'eac3', 'opus', 'flac', 'alac', 'mp3', 'dts', 'truehd', 'vorbis', 'mp2',
  'pcm_s16le', 'pcm_s24le', 'pcm_bluray',
];

/** lavf demuxer to the container names the server's decision uses. */
const CONTAINERS: ReadonlyArray<[demuxer: string, names: string[]]> = [
  ['mov', ['mp4', 'mov', 'm4v']],
  ['matroska', ['mkv']],
  ['webm', ['webm']],
  ['mpegts', ['ts', 'm2ts', 'mts']],
  ['avi', ['avi']],
  ['flv', ['flv']],
  ['mpeg', ['mpg', 'mpeg']],
  ['asf', ['wmv']],
  ['ogg', ['ogm']],
];

/** ffmpeg decodes every profile and bit depth of these in software, so the conditions follow the codec, not the machine. */
const CONDITIONS: Record<string, CodecCondition> = {
  h264: {
    codec: 'h264',
    profiles: ['baseline', 'constrained baseline', 'main', 'high', 'high 10', 'high 10 intra', 'high 4:2:2'],
    maxBitDepth: 10,
  },
  hevc: { codec: 'hevc', profiles: ['main', 'main 10'], maxBitDepth: 10 },
  av1: { codec: 'av1', profiles: ['main', 'high'], maxBitDepth: 10 },
};

/** What mpv's own decoder and demuxer lists open; the web probe's answer stands where mpv could not be asked. */
export function mpvVideo(decoders: readonly string[], demuxers: readonly string[]): WebVideo {
  const has = new Set(decoders);
  const dem = new Set(demuxers);
  const codecs = VIDEO_CODECS.filter(([d]) => has.has(d));
  return {
    containers: CONTAINERS.filter(([d]) => dem.has(d)).flatMap(([, names]) => names),
    videoCodecs: codecs.flatMap(([, names]) => names),
    codecConditions: codecs.flatMap(([d]) => (CONDITIONS[d] ? [CONDITIONS[d]] : [])),
  };
}

export function mpvAudioCodecs(decoders: readonly string[]): string[] {
  const has = new Set(decoders);
  return AUDIO_CODECS.filter((c) => has.has(c));
}
