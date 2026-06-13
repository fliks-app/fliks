/**
 * Whether a transcode session emits the multi-rendition `var_stream_map` HLS
 * layout — video in subdir `0/`, each audio track in `1..N/` — rather than one
 * muxed output. The controller decides this once via `pickAudioLayout` and
 * signals it by setting `videoOnly` on the SessionContext. Every downstream
 * consumer (the ffmpeg argv, the segment-readiness subdir probe, the session
 * layout tag) MUST agree on this predicate, or the readiness probe looks in the
 * wrong directory. The layout is in effect whenever `videoOnly` is set and
 * there is at least one audio track to map into a rendition.
 */
export function varStreamMapLayout(
  videoOnly: boolean,
  audioCount: number,
): boolean {
  return videoOnly && audioCount > 0;
}
