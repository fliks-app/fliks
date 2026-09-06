/** HDR (PQ/HLG) → SDR BT.709 for sprite tiles. The opening zscale linearises
 *  and downscales in one pass: `tonemap` only works on linear light — fed PQ
 *  code values the picture collapses to washed-out grey — and the curve then
 *  runs at tile size. `h=-2` keeps the height even, which zscale requires on
 *  subsampled formats. Source colorimetry comes from the frame tags. */
export const tonemapChain = (width: number): string =>
  `zscale=w=${width}:h=-2:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,` +
  `tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;

/** HW surfaces must come down 10-bit: converting to nv12 before the tone-map
 *  clips the PQ highlights and darkens the tile. */
export const downloadPixFmt = (hdr?: boolean): string =>
  hdr ? 'p010le' : 'nv12';
