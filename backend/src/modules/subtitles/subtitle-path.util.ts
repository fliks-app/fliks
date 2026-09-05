import { BadRequestException } from '@nestjs/common';
import * as path from 'path';

/**
 * Resolve a stored subtitle location to an absolute path under the media folder.
 * `stored` is relative to `mediaRoot` (same idea as MediaFile.relativePath); an absolute
 * value resolves to itself, and either way anything outside `mediaRoot` is refused.
 */
export function resolveSubtitleAbsolutePath(
  mediaRoot: string | null | undefined,
  stored: string | null | undefined,
): string | null {
  if (!stored?.trim()) return null;
  if (!mediaRoot?.trim()) return null;

  const trimmed = stored.trim();
  const normRoot = path.resolve(mediaRoot);

  const absolute = path.resolve(normRoot, trimmed);

  const sep = path.sep;
  if (!absolute.startsWith(normRoot + sep) && absolute !== normRoot) {
    return null;
  }

  return absolute;
}

/**
 * Guard the language part of a generated sidecar name. It is built from a
 * provider-supplied or client-supplied language, and `normalizeLanguageCode`
 * passes an unknown tag through unchanged, so a value like
 * `x/../../../../tmp/pwn` would otherwise become a path.
 */
export function assertSafeLangSuffix(suffix: string): void {
  if (!/^[a-z]{2,3}(\.(forced|hi))?$/.test(suffix)) {
    throw new BadRequestException(`Invalid subtitle language "${suffix}"`);
  }
}
