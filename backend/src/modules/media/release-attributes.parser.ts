/**
 * Generic release-name attribute extractor used by the subtitle scorer
 * (Bazarr-style) to compare a candidate subtitle's release name with the
 * local video file's release name and award per-attribute credit.
 *
 * Complements {@link parseReleaseQuality} (which already picks resolution
 * + source) by also extracting release_group, video_codec, audio_codec
 * and edition. Resolution + source are re-extracted here so downstream
 * code can score against a single shape without coupling to AppQuality.
 */

export type ReleaseSource =
  | 'remux'
  | 'bluray'
  | 'web-dl'
  | 'webrip'
  | 'hdtv'
  | 'dvd'
  | 'sdtv'
  | 'cam'
  | 'ts'
  | 'tc'
  | null;

export type VideoCodec = 'h265' | 'h264' | 'av1' | 'vp9' | 'xvid' | 'mpeg2' | null;

export type AudioCodec =
  | 'truehd'
  | 'dts-hd'
  | 'dts'
  | 'eac3'
  | 'ac3'
  | 'flac'
  | 'aac'
  | 'opus'
  | 'mp3'
  | null;

export type ReleaseEdition =
  | 'directors-cut'
  | 'extended'
  | 'theatrical'
  | 'uncut'
  | 'remastered'
  | 'criterion'
  | 'imax'
  | null;

export interface ReleaseAttributes {
  /** 2160, 1080, 720, 480 … 0 when not detected. */
  resolution: number;
  source: ReleaseSource;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  edition: ReleaseEdition;
  /** Group suffix after the final dash, e.g. `-CtrlHD`. Lowercased. */
  releaseGroup: string | null;
  /** True when the release name carries an SDH / HI marker. */
  hearingImpaired: boolean;
}

function norm(s: string): string {
  return s.replace(/\./g, ' ').toLowerCase();
}

function detectResolution(t: string): number {
  if (/\b(4320p?|8k)\b/.test(t)) return 4320;
  if (/\b(2160p?|4k|uhd)\b/.test(t)) return 2160;
  if (/\b1080[ip]?\b/.test(t)) return 1080;
  if (/\b720[ip]?\b/.test(t)) return 720;
  const m = t.match(/\b(576|480|360)p?\b/);
  return m ? parseInt(m[1], 10) : 0;
}

function detectSource(t: string): ReleaseSource {
  if (/\bremux\b/.test(t)) return 'remux';
  if (/\b(bluray|blu-?ray|bdrip|brrip|bdr)\b/.test(t)) return 'bluray';
  if (/\bweb-?dl\b/.test(t)) return 'web-dl';
  if (/\bweb-?rip\b/.test(t)) return 'webrip';
  if (/\bhdtv\b/.test(t)) return 'hdtv';
  if (/\b(dvd|dvdrip|dvd-?r)\b/.test(t)) return 'dvd';
  if (/\bsdtv\b/.test(t)) return 'sdtv';
  if (/\bcam\b/.test(t)) return 'cam';
  if (/\b(ts|telesync)\b/.test(t)) return 'ts';
  if (/\btc\b|telecine/.test(t)) return 'tc';
  return null;
}

function detectVideoCodec(t: string): VideoCodec {
  if (/\b(h\.?265|x265|hevc)\b/.test(t)) return 'h265';
  if (/\b(h\.?264|x264|avc)\b/.test(t)) return 'h264';
  if (/\bav1\b/.test(t)) return 'av1';
  if (/\bvp9\b/.test(t)) return 'vp9';
  if (/\bxvid\b/.test(t)) return 'xvid';
  if (/\b(mpeg-?2|mpg2)\b/.test(t)) return 'mpeg2';
  return null;
}

function detectAudioCodec(t: string): AudioCodec {
  if (/\btruehd\b/.test(t)) return 'truehd';
  if (/\bdts-?hd\b/.test(t)) return 'dts-hd';
  if (/\bdts\b/.test(t)) return 'dts';
  if (/\be-?ac-?3\b|\bddp\b/.test(t)) return 'eac3';
  if (/\bac-?3\b|\bdd5\b/.test(t)) return 'ac3';
  if (/\bflac\b/.test(t)) return 'flac';
  if (/\baac\b/.test(t)) return 'aac';
  if (/\bopus\b/.test(t)) return 'opus';
  if (/\bmp3\b/.test(t)) return 'mp3';
  return null;
}

function detectEdition(t: string): ReleaseEdition {
  if (/\b(director'?s?[\s\-_]?cut|dc)\b/.test(t)) return 'directors-cut';
  if (/\bextended\b/.test(t)) return 'extended';
  if (/\btheatrical\b/.test(t)) return 'theatrical';
  if (/\buncut\b/.test(t)) return 'uncut';
  if (/\bremastered\b/.test(t)) return 'remastered';
  if (/\bcriterion\b/.test(t)) return 'criterion';
  if (/\bimax\b/.test(t)) return 'imax';
  return null;
}

function detectReleaseGroup(rawTitle: string): string | null {
  // Group is typically the token after the LAST dash before the extension.
  // Use the original title (not normalised) because group casing can carry
  // meaning, but match case-insensitively.
  const stem = rawTitle.replace(/\.[a-z0-9]{2,4}$/i, '');
  const m = stem.match(/-([a-z0-9_]+)$/i);
  if (!m) return null;
  const group = m[1].toLowerCase();
  // Reject obvious false positives (resolutions, sources, codecs).
  if (/^(1080p|720p|2160p|480p|hevc|x264|x265|av1|h264|h265|dvd|web|bluray|remux)$/.test(group)) {
    return null;
  }
  return group;
}

function detectHearingImpaired(t: string): boolean {
  return /\b(sdh|hi|hearing[\s\-_]?impaired|cc|closed[\s\-_]?caption)\b/.test(t);
}

/**
 * Parse a release name (torrent title, file name) into the attribute set
 * the subtitle scorer compares against the video file.
 */
export function parseReleaseAttributes(title: string): ReleaseAttributes {
  const t = norm(title);
  return {
    resolution: detectResolution(t),
    source: detectSource(t),
    videoCodec: detectVideoCodec(t),
    audioCodec: detectAudioCodec(t),
    edition: detectEdition(t),
    releaseGroup: detectReleaseGroup(title),
    hearingImpaired: detectHearingImpaired(t),
  };
}
