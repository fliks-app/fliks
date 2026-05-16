/** Build the height argument for ffmpeg's software `scale` filter so the
 *  CPU pipeline produces mod-16 output — matching what HW encoders emit
 *  (`scale_vaapi=h=-16`) and what the master playlist advertises
 *  (`profileResolution` snaps to mod-16). `scale=W:-2` alone produces
 *  mod-2, which drifts on theatrical 4K masters (3840×2024 → 2024 mod-2
 *  vs 2016 mod-16); a `-2`/`-16` mismatch between the bitstream and the
 *  master `RESOLUTION` attribute can trip MSE on append and leaves the
 *  player guessing about the pixel grid.
 *
 *  Inline expression preserves source aspect via `ih*W/iw` and rounds
 *  the height down to the nearest multiple of 16. No `max(…)` guard:
 *  any `,` inside a filter option ends the current filter, and even an
 *  escaped one is fragile across ffmpeg builds — real video sources
 *  are always large enough that mod-16 is non-zero. */
export function scaleMod16Height(targetWidth: number): string {
  return `trunc(ih*${targetWidth}/iw/16)*16`;
}
