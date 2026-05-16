import type { EncoderDescriptor, EncoderInput, HdrFormat } from '../../types';

/** Standard ffmpeg `-color_*` flag triplet for an HDR bitstream. BT.2020
 *  primaries and matrix; transfer characteristic switches PQ (HDR10) vs
 *  HLG. Belt-and-suspenders: most encoders carry color tags through from
 *  the input AVFrame, but several HW builds (notably hevc_qsv) drop them
 *  silently. Hard-coding the SPS VUI here prevents that regression. */
export function hdrColorArgs(format: HdrFormat | 'HDR10' | 'HLG'): string[] {
  const trc = format === 'HLG' ? 'arib-std-b67' : 'smpte2084';
  return [
    '-color_primaries',
    'bt2020',
    '-color_trc',
    trc,
    '-colorspace',
    'bt2020nc',
  ];
}

/** Build an HLG-variant descriptor from an existing HDR10 descriptor by
 *  swapping the `-color_trc` value from PQ (`smpte2084`) to HLG
 *  (`arib-std-b67`) on the encoder args. Only valid when the encoder's
 *  HDR signaling lives entirely in the standard `-color_*` flags (the
 *  case for QSV / VAAPI / NVENC / VideoToolbox). CPU encoders that
 *  carry HDR config through encoder-specific params (`-x265-params`,
 *  `-svtav1-params`) build their HLG variant by hand. */
export function hlgFromHdr10(
  id: string,
  hdr10: EncoderDescriptor,
): EncoderDescriptor {
  return {
    ...hdr10,
    id,
    variant: { ...hdr10.variant, hdr: 'HLG' },
    buildArgs(input: EncoderInput) {
      const args = hdr10.buildArgs(input);
      const tIdx = args.indexOf('-color_trc');
      if (tIdx !== -1) args[tIdx + 1] = 'arib-std-b67';
      return args;
    },
  };
}
