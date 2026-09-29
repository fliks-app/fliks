import { Logger } from '@nestjs/common';
import type { HdrStaticMetadata } from '../../types';

const logger = new Logger('HdrMetadata');

/** Generic 1000-nit BT.2020 HDR10 reference, used when the source carried no
 *  ST 2086 mastering-display metadata — the encoder still emits a valid (if
 *  approximate) signal. Replaced by the source's real values when probed. */
const GENERIC_MASTER_DISPLAY =
  'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)';
const GENERIC_MAX_CLL = '1000,400';

/**
 * `master-display` value — the source's mastering display when probed, else the
 * generic 1000-nit reference. The `G(gx,gy)B(bx,by)R(rx,ry)WP(wx,wy)L(max,min)`
 * integer format is shared by x265 (`master-display=`) and ffmpeg's NVENC-only
 * `-master_display`. SVT-AV1 4.x wants decimal values, see `svtMasterDisplayString`.
 */
export function masterDisplayString(meta?: HdrStaticMetadata): string {
  return meta?.masteringDisplay || GENERIC_MASTER_DISPLAY;
}

/**
 * `max-cll` value (`maxCLL,maxFALL`) — the source's content light level when
 * probed (`0,0` when the source had mastering metadata but no CLL, which is the
 * valid "unknown" signal), else the generic reference. Same integer format as
 * SVT-AV1's `content-light`, so this is reused as-is for that encoder.
 */
export function maxCllString(meta?: HdrStaticMetadata): string {
  if (!meta) return GENERIC_MAX_CLL;
  return `${meta.maxCll},${meta.maxFall}`;
}

const MASTER_DISPLAY_RE =
  /^G\((\d+),(\d+)\)B\((\d+),(\d+)\)R\((\d+),(\d+)\)WP\((\d+),(\d+)\)L\((\d+),(\d+)\)$/;

/**
 * SVT-AV1's `mastering-display` value: same layout as `masterDisplayString`
 * but chromaticities and luminance as decimals (ST 2086 units / 50000, / 10000).
 */
export function svtMasterDisplayString(meta?: HdrStaticMetadata): string {
  const raw = masterDisplayString(meta);
  let m = raw.match(MASTER_DISPLAY_RE);
  if (!m) {
    logger.warn(`unparseable master-display "${raw}", using the generic reference`);
    m = GENERIC_MASTER_DISPLAY.match(MASTER_DISPLAY_RE)!;
  }
  const [gx, gy, bx, by, rx, ry, wx, wy, lmax, lmin] = m.slice(1).map(Number);
  const chroma = (v: number) => Number((v / 50000).toFixed(5));
  const lum = (v: number) => Number((v / 10000).toFixed(5));
  return (
    `G(${chroma(gx)},${chroma(gy)})B(${chroma(bx)},${chroma(by)})` +
    `R(${chroma(rx)},${chroma(ry)})WP(${chroma(wx)},${chroma(wy)})` +
    `L(${lum(lmax)},${lum(lmin)})`
  );
}
