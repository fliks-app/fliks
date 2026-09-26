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

/** How a source's audio is laid out in HLS: one EXT-X-MEDIA rendition per track
 *  (`var-stream-map`, a video-only main the player switches tracks against) for
 *  several tracks, else muxed next to the video. A single track stays muxed on
 *  every mux flavour: `cmaf-rewrite` makes muxed fMP4 parse on AVPlay, and a
 *  one-variant master never triggers its rendition probe. */
export function audioLayout(audioCount: number): 'inline' | 'var-stream-map' {
  return audioCount > 1 ? 'var-stream-map' : 'inline';
}

/** Whether a session's ffmpeg run, readiness probe and serve paths use the
 *  var_stream_map subdirectories: the session was set up video-only
 *  (`sessionLayoutContext`) for a source {@link audioLayout} splits. */
export function varStreamMapLayout(
  videoOnly: boolean,
  audioCount: number,
): boolean {
  return videoOnly && audioLayout(audioCount) === 'var-stream-map';
}
