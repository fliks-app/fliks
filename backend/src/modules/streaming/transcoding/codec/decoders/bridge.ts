import type { HwAccelType } from '../../types';
import type { BitDepth } from '../types';
import type { SurfaceFormat } from './types';

/** Build the filter snippet that turns a decoder output surface into the
 *  surface the encoder expects. Returned string is either empty or ends
 *  with a comma so the encoder concatenates it as-is at the head of its
 *  `-vf` chain.
 *
 *  The semantics rely on libavfilter's standard bridges:
 *  - `hwdownload,format=<sw>` : pull a HW surface to main memory at the
 *    given software pixel format. nv12 for 8-bit, p010le for 10-bit.
 *  - `format=<sw>,hwupload`   : push a software frame onto the active
 *    HW device's surface pool.
 *  - `hwmap=derive_device=<target>,format=<target>` : zero-copy reroute
 *    when the source and target share GPU memory (VAAPI ↔ QSV on
 *    Intel Linux). */
export function surfaceBridge(
  from: SurfaceFormat,
  toHwAccel: HwAccelType,
  bitDepth: BitDepth,
): string {
  const swFmt = bitDepth === 10 ? 'p010le' : 'nv12';

  if (from === surfaceFormatFor(toHwAccel)) return '';

  // CPU encoder: pull HW surfaces down to software. VideoToolbox decode
  // is treated as `'cpu'` already, so it never falls in here.
  if (toHwAccel === 'none') {
    if (from === 'cpu') return '';
    return `hwdownload,format=${swFmt},`;
  }

  // CPU source going to a HW encoder: upload onto the encoder's device.
  if (from === 'cpu') {
    if (toHwAccel === 'nvenc') return `format=${swFmt},hwupload_cuda,`;
    // qsv and vaapi: the active filter device is initialised in the
    // orchestrator's input setup, so plain hwupload picks the right
    // target.
    return `format=${swFmt},hwupload,`;
  }

  // VAAPI ↔ QSV: shared Intel device, hwmap is zero-copy.
  if (from === 'vaapi' && toHwAccel === 'qsv') {
    return `hwmap=derive_device=qsv,format=qsv,`;
  }
  if (from === 'qsv' && toHwAccel === 'vaapi') {
    return `hwmap=derive_device=vaapi,format=vaapi,`;
  }

  // Cross-family HW (e.g. vaapi → cuda): nothing zero-copy. Round-trip
  // through CPU. Slow but correct; not a path we exercise on supported
  // configurations.
  return `hwdownload,format=${swFmt},hwupload,`;
}

/** Map an encoder's `hwAccel` to the surface format its `-c:v` consumes. */
function surfaceFormatFor(hwAccel: HwAccelType): SurfaceFormat {
  switch (hwAccel) {
    case 'qsv':
      return 'qsv';
    case 'vaapi':
      return 'vaapi';
    case 'nvenc':
      return 'cuda';
    case 'videotoolbox':
      return 'videotoolbox';
    case 'none':
      return 'cpu';
  }
}
