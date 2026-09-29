import type { DeviceProfileDto } from '../../dto/device-profile.dto';

/** Dolby Vision classification derived from a stream's DOVI configuration
 *  record. Single-layer profiles (5, 8, 10) carry their DV inside the base
 *  NALs, so a raw stream copy preserves DV with no re-encode; dual-layer P7's
 *  enhancement layer is unreachable over HLS, so it is never single-layer here. */
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
  colorRange?: string;
  colorSpace?: string;
  pixelFormat?: string;
  bitDepth?: number;
}

/** DV profiles a client can decode AND present; a bare boolean falls back to
 *  [5, 8] and never implies profile 10. */
export function clientDvProfiles(
  p: Pick<DeviceProfileDto, 'dolbyVisionProfiles' | 'supportsDolbyVision'>,
): number[] {
  return p.dolbyVisionProfiles ?? (p.supportsDolbyVision === true ? [5, 8] : []);
}

export function deriveDvInfo(v?: DvStream): DvInfo {
  const profile = v?.dvProfile;
  const compatId = v?.dvBlSignalCompatId;
  const singleLayer =
    (profile === 5 || profile === 8 || profile === 10) && v?.dvElPresent !== true;
  return { profile, compatId, singleLayer };
}

/** P5, or P10 with compat 0/unknown: no base layer, so a non-DV client must
 *  tone-map. Unknown compat is treated as no base (the safe side). */
export function dvHasNoBase(
  profile: number | undefined,
  compat: number | undefined,
): boolean {
  return profile === 5 || (profile === 10 && (compat === 0 || compat == null));
}

/** P8.4/P10.4: HLG base with no static HDR metadata. Apple's HLG→SDR
 *  conversion of that base alone maps far too dark; the RPU carries the grade. */
export function dvHasHlgBase(
  profile: number | undefined,
  compat: number | undefined,
): boolean {
  return (profile === 8 || profile === 10) && compat === 4;
}

/** RFC 8216bis SUPPLEMENTAL-CODECS for a DV base layer (P8→`dvh1.08.LL`,
 *  P10→`dav1.10.LL`); null unless it passes the bundled ffmpeg's dvcC/dvvC gate. */
export function dvSupplementalCodecs(v?: DvStream): string | null {
  const prefix =
    v?.dvProfile === 8 ? 'dvh1.08' : v?.dvProfile === 10 ? 'dav1.10' : null;
  if (!prefix || !v?.dvLevel) return null;
  if (v.colorRange !== 'tv' || v.colorSpace !== 'bt2020nc') return null;
  if (v.pixelFormat !== 'yuv420p10' && v.pixelFormat !== 'yuv420p10le') return null;
  const level = String(v.dvLevel).padStart(2, '0');
  if (v.dvBlSignalCompatId === 1 && v.hdrFormat === 'HDR10') return `${prefix}.${level}/db1p`;
  if (v.dvBlSignalCompatId === 4 && v.hdrFormat === 'HLG') return `${prefix}.${level}/db4h`;
  return null;
}

/** RFC 8216bis CODECS for a no-base remux: P5 (`dvh1.05.LL`) or P10.0
 *  (`dav1.10.LL`, compat 0/unknown). Null without a probed level or match. */
export function dvStandaloneCodecs(v?: DvStream): string | null {
  if (!v?.dvLevel) return null;
  const level = String(v.dvLevel).padStart(2, '0');
  if (v.dvProfile === 5) return `dvh1.05.${level}`;
  if (v.dvProfile === 10 && (v.dvBlSignalCompatId === 0 || v.dvBlSignalCompatId == null)) {
    return `dav1.10.${level}`;
  }
  return null;
}
