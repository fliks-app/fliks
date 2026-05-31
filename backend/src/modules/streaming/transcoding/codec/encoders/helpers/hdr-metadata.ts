import type { HdrStaticMetadata } from '../../types';

/** Generic 1000-nit BT.2020 HDR10 reference, used when the source carried no
 *  ST 2086 mastering-display metadata — the encoder still emits a valid (if
 *  approximate) signal. Replaced by the source's real values when probed. */
const GENERIC_MASTER_DISPLAY =
  'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)';
const GENERIC_MAX_CLL = '1000,400';

/**
 * `master-display` value — the source's mastering display when probed, else the
 * generic 1000-nit reference. The `G(gx,gy)B(bx,by)R(rx,ry)WP(wx,wy)L(max,min)`
 * format is shared by x265 (`master-display=`), SVT-AV1 (`mastering-display=`)
 * and ffmpeg (`-master_display`).
 */
export function masterDisplayString(meta?: HdrStaticMetadata): string {
  return meta?.masteringDisplay || GENERIC_MASTER_DISPLAY;
}

/**
 * `max-cll` value (`maxCLL,maxFALL`) — the source's content light level when
 * probed (`0,0` when the source had mastering metadata but no CLL, which is the
 * valid "unknown" signal), else the generic reference.
 */
export function maxCllString(meta?: HdrStaticMetadata): string {
  if (!meta) return GENERIC_MAX_CLL;
  return `${meta.maxCll},${meta.maxFall}`;
}
