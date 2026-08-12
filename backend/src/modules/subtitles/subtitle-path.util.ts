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
