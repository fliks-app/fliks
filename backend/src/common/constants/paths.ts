import * as os from 'os';
import * as path from 'path';

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
