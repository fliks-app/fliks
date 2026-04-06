import * as path from 'path';

/**
 * Relative path from a media folder root to a file, always using resolved paths.
 * Returns null if the file is not under the root (path.relative would contain `..`).
 */
export function relativePathUnderMediaRoot(
  mediaRoot: string | null | undefined,
  filePath: string,
): string | null {
  if (!mediaRoot?.trim()) return null;
  const root = path.resolve(mediaRoot.trim());
  const abs = path.resolve(filePath);
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return rel;
}
