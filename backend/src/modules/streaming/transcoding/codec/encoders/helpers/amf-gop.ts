/** Closed-GOP flags for the AMF encoders: `-forced_idr 1` makes every
 *  `force_key_frames` tick a real IDR (av1_amf would emit an intra-only frame,
 *  which keeps its references and is no random-access point), `-bf 0` drops
 *  B-frame reordering so the muxer cuts on the boundary. */
export const AMF_GOP_ARGS: readonly string[] = ['-forced_idr', '1', '-bf', '0'];
