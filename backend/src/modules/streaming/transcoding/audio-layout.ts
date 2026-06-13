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

/** Decide whether ffmpeg emits muxed segments (`inline`) or the EXT-X-MEDIA
 *  layout (`var-stream-map`: a video-only main + audio served as separate
 *  renditions). The controller asks this once and signals it by setting
 *  `videoOnly` on the SessionContext; {@link varStreamMapLayout} is the
 *  downstream "is it in effect" check.
 *
 *  Rules:
 *    1. Zero audio sources → inline (no audio rendition to emit).
 *    2. Multi-audio sources → var-stream-map (Shaka / AVPlay switch the
 *       rendition client-side without a backend reload).
 *    3. Single-audio sources → inline regardless of mux flavour. The
 *       `cmaf-rewrite` post-processor makes muxed fMP4 parse on AVPlay too
 *       (issue #148), and the single-variant master that comes with
 *       single-audio doesn't trigger AVPlay's audio-rendition probe — so
 *       inline is the only layout that plays on Tizen single-audio fMP4. */
export function pickAudioLayout(
  audioCount: number,
  _muxFlavour: 'ts' | 'fmp4',
): 'inline' | 'var-stream-map' {
  if (audioCount <= 1) return 'inline';
  return 'var-stream-map';
}
