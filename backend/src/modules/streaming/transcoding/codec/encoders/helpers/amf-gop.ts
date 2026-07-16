/** Closed-GOP flags for the AMF encoders — the generic HLS fix (each
 *  segment must start on a self-decodable IDR). `-forced_idr 1` makes every
 *  `force_key_frames` tick a real IDR; `-bf 0` drops B-frame reordering so
 *  the muxer cuts cleanly on the boundary. */
export const AMF_GOP_ARGS: readonly string[] = ['-forced_idr', '1', '-bf', '0'];

/** AV1 AMF variant — `av1_amf` has no `-forced_idr` option (passing an
 *  unknown option aborts the encoder and drops it to the CPU fallback), so
 *  only `-bf 0` is applied. */
export const AV1_AMF_GOP_ARGS: readonly string[] = ['-bf', '0'];
