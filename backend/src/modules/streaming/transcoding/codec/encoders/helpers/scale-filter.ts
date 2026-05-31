/** Build the height argument for ffmpeg's software `scale` filter, preserving
 *  source aspect and rounding to the nearest even (mod-2) value. mod-2 is the
 *  codec minimum for 4:2:0 and what `profileResolution` advertises in the
 *  master `RESOLUTION`, so manifest and bitstream agree on a clean square-pixel
 *  size — e.g. 1920x1080 (SAR 1:1), the standard streaming rung. Forcing mod-16
 *  instead yields 1920x1088 with a 136:135 SAR (a non-standard aspect hack):
 *  mod-16 is the encoder's internal macroblock/CTU grid, handled transparently
 *  via the conformance window, never an output dimension. Matches the HW paths
 *  (`scale_cuda=h=-2`, `scale_vt=h=-2`, `scale_vaapi=h=-2`).
 *
 *  Inline expression (no `max(…)` guard): a `,` inside a filter option ends the
 *  filter, and real sources are always large enough that mod-2 is non-zero. */
export function scaleEvenHeight(targetWidth: number): string {
  return `ceil(ih*${targetWidth}/iw/2)*2`;
}
