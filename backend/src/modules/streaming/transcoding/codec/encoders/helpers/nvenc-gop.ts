/** Closed-GOP, deterministic-IDR flags for the NVENC descriptors. Mirrors
 *  the qsv-extra recipe (see ffmpeg-args.ts): without `-forced-idr`, NVENC
 *  emits some `force_key_frames` ticks as plain (non-IDR) I-frames, so the
 *  HLS segment boundary isn't a clean random-access point and the segment
 *  can't be decoded on its own — the visible failure is heavy macroblock
 *  corruption from the first segment. `-bf 0` drops B-frame reordering
 *  across the segment edge so the muxer cuts cleanly on each IDR;
 *  `-no-scenecut` keeps adaptive I-frames off the forced grid.
 */
export const NVENC_GOP_ARGS: readonly string[] = [
  '-forced-idr',
  '1',
  '-no-scenecut',
  '1',
  '-bf',
  '0',
];

/** AV1 NVENC variant of {@link NVENC_GOP_ARGS}. `av1_nvenc` shares
 *  `-forced-idr` and `-bf` but has no `-no-scenecut` option, so it is
 *  omitted here (passing an unknown option would abort av1_nvenc and drop
 *  it to the libsvtav1 fallback). */
export const AV1_NVENC_GOP_ARGS: readonly string[] = [
  '-forced-idr',
  '1',
  '-bf',
  '0',
];
