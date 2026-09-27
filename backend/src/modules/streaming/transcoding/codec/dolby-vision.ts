/** Dolby Vision classification derived from a stream's DOVI configuration
 *  record. Single-layer profiles (5, 8) carry their DV inside the HEVC NALs, so
 *  a raw stream copy preserves DV with no re-encode; dual-layer P7's enhancement
 *  layer is unreachable over HLS, so it is never single-layer here. */
export interface DvInfo {
  profile?: number;
  compatId?: number;
  singleLayer: boolean;
}

export interface DvStream {
  dvProfile?: number;
  dvBlSignalCompatId?: number;
  dvElPresent?: boolean;
  dvLevel?: number;
  hdrFormat?: string;
}

export function deriveDvInfo(v?: DvStream): DvInfo {
  const profile = v?.dvProfile;
  const compatId = v?.dvBlSignalCompatId;
  const singleLayer =
    (profile === 5 || profile === 8) && v?.dvElPresent !== true;
  return { profile, compatId, singleLayer };
}

/** Profile 5: single-layer IPT-PQ-C2 with no HDR10 base. A non-DV client that
 *  copies it renders green/purple, so it forces a tonemap transcode unless the
 *  client can present DV. */
export function isDvProfile5(info: DvInfo): boolean {
  return info.profile === 5 && info.singleLayer;
}

/** RFC 8216bis SUPPLEMENTAL-CODECS for a P8 base: `db1p` for PQ compat-1,
 *  `db4h` for HLG compat-4; null on any other profile/compat/transfer/level. */
export function dvSupplementalCodecs(v?: DvStream): string | null {
  if (v?.dvProfile !== 8 || !v?.dvLevel) return null;
  const level = String(v.dvLevel).padStart(2, '0');
  if (v.dvBlSignalCompatId === 1 && v.hdrFormat === 'HDR10') return `dvh1.08.${level}/db1p`;
  if (v.dvBlSignalCompatId === 4 && v.hdrFormat === 'HLG') return `dvh1.08.${level}/db4h`;
  return null;
}
