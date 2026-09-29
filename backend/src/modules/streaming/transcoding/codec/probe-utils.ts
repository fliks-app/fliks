import * as os from 'os';
import * as path from 'path';

/** Last two lines of a failed probe's ffmpeg stderr, for the boot log. */
export function ffmpegTail(err: unknown): string {
  const stderr = (err as { stderr?: string } | undefined)?.stderr?.trim();
  return stderr ? stderr.split('\n').slice(-2).join(' ') : '';
}

/** Tmp path for a boot-probe sample bitstream, unique per process so
 *  concurrent boots (tests, multiple instances) never collide. */
export function probeSamplePath(name: string, ext = 'hevc'): string {
  return path.join(os.tmpdir(), `fliks-${name}-probe-${process.pid}.${ext}`);
}
