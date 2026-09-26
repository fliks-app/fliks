/** Segment container of a transcode session: MPEG-TS when the profile forces it,
 *  or asks for it on single-audio sources (AVPlay); fMP4 otherwise. */
export function resolveMuxFlavour(
  profile: { useTs?: boolean; useTsOnSingleAudio?: boolean },
  audioCount: number,
): 'ts' | 'fmp4' {
  return profile.useTs || (profile.useTsOnSingleAudio && audioCount <= 1)
    ? 'ts'
    : 'fmp4';
}

/** One EXT-X-MEDIA rendition per track for several tracks, else muxed: a muxed
 *  fMP4 parses on AVPlay (`cmaf-rewrite`), and a one-variant master skips its rendition probe. */
export function audioLayout(audioCount: number): 'inline' | 'var-stream-map' {
  return audioCount > 1 ? 'var-stream-map' : 'inline';
}

/** Whether the ffmpeg run, readiness probe and serve paths use var_stream_map
 *  subdirectories: a video-only session of a source {@link audioLayout} splits. */
export function varStreamMapLayout(
  videoOnly: boolean,
  audioCount: number,
): boolean {
  return videoOnly && audioLayout(audioCount) === 'var-stream-map';
}
