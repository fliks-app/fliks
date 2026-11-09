export interface MpvLists {
  /** Codec names of mpv's decoders (ffmpeg's: `h264`, `hevc`, `eac3`...). */
  decoders: string[];
  /** Demuxer names of mpv's lavf (`matroska`, `webm`, `mov`, `mpegts`...). */
  demuxers: string[];
}

/** `decoder-list` is JSON text from libmpv and parsed objects over mpv's IPC; `demuxer-lavf-list` is comma text or an array. */
export function parseMpvLists(decoderList: unknown, demuxerList: unknown): MpvLists {
  const decoders = typeof decoderList === 'string' ? JSON.parse(decoderList) : decoderList;
  const names = (v: unknown): string[] =>
    (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).filter(
      (n): n is string => typeof n === 'string' && n !== '',
    );
  return {
    decoders: [...new Set((Array.isArray(decoders) ? decoders : []).map((d) => d?.codec).filter((c) => typeof c === 'string'))],
    demuxers: names(demuxerList).flatMap((n) => n.split(',')),
  };
}
