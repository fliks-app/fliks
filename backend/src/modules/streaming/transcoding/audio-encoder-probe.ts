import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Populated once at boot (awaited from `onModuleInit`), read by
 *  `isLibfdkAacEnabled()` from then on; false until then, same as absent. */
let libfdkEnabled = false;

/** True once the boot probe found `libfdk_aac` in this ffmpeg build. False
 *  (native `aac` fallback) before the probe finishes or when it's absent,
 *  e.g. macOS Homebrew ffmpeg, which doesn't bundle the Fraunhofer encoder. */
export function isLibfdkAacEnabled(): boolean {
  return libfdkEnabled;
}

/** `ffmpeg -encoders` lists every compiled-in codec once; audio encoders carry
 *  no device/driver risk the way HW video encoders do, so a listing check is
 *  enough, no black-frame encode test needed. */
export async function runAudioEncoderProbe(log: Logger): Promise<void> {
  const t0 = Date.now();
  try {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      ['-hide_banner', '-encoders'],
      { timeout: 10_000 },
    );
    libfdkEnabled = /\blibfdk_aac\b/.test(stdout);
  } catch {
    libfdkEnabled = false;
  } finally {
    log.log(
      `[audio-encoder-probe] libfdk_aac=${libfdkEnabled} (${Date.now() - t0}ms)`,
    );
  }
}
