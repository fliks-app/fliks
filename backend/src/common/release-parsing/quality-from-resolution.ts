import { APP_QUALITIES } from '../constants/app-qualities';
import { bucketResolutionHeight } from '../utils/resolution.util';

/**
 * Resolve a quality name from the ACTUAL video dimensions plus the source tag
 * (bluray / web / remux …) sniffed from `sourceText` (a release name or
 * filename). Unlike parseReleaseQuality, which trusts the release name's
 * resolution claim, this buckets by real pixels — so a release mislabeled
 * "2160p" that is really 1920×804 resolves to a 1080p quality.
 */
export function qualityFromResolution(
  sourceText: string,
  actualWidth?: number,
  actualHeight?: number,
): string {
  // Clamp to APP_QUALITIES' supported resolutions (480 / 720 / 1080 / 2160).
  // Tiny sub-480 sources fall back to 480 (no 144/240/360 entries exist).
  const bucket = bucketResolutionHeight(actualWidth, actualHeight);
  const resolution = bucket >= 2160 ? 2160 : bucket <= 480 ? 480 : bucket;

  const t = sourceText.replace(/\./g, ' ').toLowerCase();
  let source = 'hdtv';
  if (/\bremux\b/.test(t)) source = 'remux';
  else if (/\b(bluray|blu-?ray|bdrip|brrip)\b/.test(t)) source = 'bluray';
  else if (/\bweb-?dl\b/.test(t)) source = 'web';
  else if (/\bweb-?rip\b/.test(t)) source = 'web';
  else if (/\b(dvd|dvdrip)\b/.test(t)) source = 'dvd';

  const match = APP_QUALITIES.find(
    (q) => q.resolution === resolution && q.source === source,
  );
  if (match) return match.name;

  const fallback = APP_QUALITIES.find((q) => q.resolution === resolution);
  return fallback?.name ?? `HDTV-${resolution}p`;
}
