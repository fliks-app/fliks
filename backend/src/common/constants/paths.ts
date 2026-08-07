import * as os from 'os';
import * as path from 'path';
import { resolveWritableDir } from './writable-dir';

/** Base directory for transient transcode/thumbnail data.
 *  `FLIKS_TRANSCODE_DIR` overrides; Windows falls back to `%TEMP%`, other
 *  platforms to `/tmp/transcode`. */
const transcodeDirOverride = process.env.FLIKS_TRANSCODE_DIR?.trim();
export const TRANSCODE_DIR =
  transcodeDirOverride && transcodeDirOverride.length > 0
    ? transcodeDirOverride
    : process.platform === 'win32'
      ? path.join(os.tmpdir(), 'fliks-transcode')
      : '/tmp/transcode';

let cachedImagesDir: string | null = null;

/**
 * Posters, fanart and seek-preview sprites. `FLIKS_IMAGES_DIR` overrides;
 * falls back to a temp dir (wiped on restart) if `/app/images` isn't
 * writable at the container's uid. Resolved and probed once, on first call.
 */
export function getImagesDir(): string {
  if (cachedImagesDir) return cachedImagesDir;
  const override = process.env.FLIKS_IMAGES_DIR?.trim();
  cachedImagesDir = resolveWritableDir(
    [override || path.join(process.cwd(), 'images'), path.join(os.tmpdir(), 'fliks-images')],
    'Cannot write to the images directory — posters, fanart and seek-preview ' +
      'sprites will not survive a restart. Set FLIKS_IMAGES_DIR, or mount ' +
      '/app/images writable for this container user.',
  );
  return cachedImagesDir;
}
