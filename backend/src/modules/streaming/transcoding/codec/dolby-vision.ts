/** Dolby Vision classification derived from a stream's DOVI configuration
 *  record. Single-layer profiles (5, 8) carry their DV inside the HEVC NALs, so
 *  a raw stream copy preserves DV with no re-encode; dual-layer P7's enhancement
 *  layer is unreachable over HLS, so it is never single-layer here. */
export interface DvInfo {
  profile?: number;
  compatId?: number;
  singleLayer: boolean;
  /** EXT-X-SUPPLEMENTAL-CODECS brand for the base-layer compatibility:
   *  db1p = 8.1 (HDR10 base), db4h = 8.4 (HLG base). */
  supplementalTag: 'db1p' | 'db4h' | null;
}

export interface DvStream {
  dvProfile?: number;
  dvBlSignalCompatId?: number;
  dvElPresent?: boolean;
}

export function deriveDvInfo(v?: DvStream): DvInfo {
  const profile = v?.dvProfile;
  const compatId = v?.dvBlSignalCompatId;
  const singleLayer =
    (profile === 5 || profile === 8) && v?.dvElPresent !== true;
  const supplementalTag =
    compatId === 1 ? 'db1p' : compatId === 4 ? 'db4h' : null;
  return { profile, compatId, singleLayer, supplementalTag };
}

/** Profile 5: single-layer IPT-PQ-C2 with no HDR10 base. A non-DV client that
 *  copies it renders green/purple, so it forces a tonemap transcode unless the
 *  client can present DV. */
export function isDvProfile5(info: DvInfo): boolean {
  return info.profile === 5 && info.singleLayer;
}
