import { Logger } from '@nestjs/common';
import { spawn, type ChildProcess } from 'child_process';

/** How this host's ffmpeg build can be paused mid-run:
 *  - `stdin`: jellyfin-ffmpeg's `p`/`u` stdin keys (Linux/Windows/macOS).
 *  - `signal`: POSIX SIGSTOP/SIGCONT fallback for a build without the key.
 *  - `none`: neither, a Windows build without the key has no fallback. */
export type PauseCapability = 'stdin' | 'signal' | 'none';

let capability: PauseCapability = 'none';
let probed = false;

export function getPauseCapability(): PauseCapability {
  return capability;
}

/** Test-only: force a capability without spawning a real probe ffmpeg. */
export function setPauseCapabilityForTest(c: PauseCapability): void {
  capability = c;
  probed = true;
}

/** Pause a running ffmpeg the way this host's build supports. No-op under
 *  `'none'`, the throttle service never calls this then, but a stray call
 *  must not throw. */
export function pauseProcess(proc: ChildProcess, log: Logger): void {
  try {
    if (capability === 'stdin') proc.stdin?.write('p');
    else if (capability === 'signal') proc.kill('SIGSTOP');
  } catch (err) {
    log.warn(`[throttle] pause failed: ${(err as Error).message}`);
  }
}

export function resumeProcess(proc: ChildProcess, log: Logger): void {
  try {
    if (capability === 'stdin') proc.stdin?.write('u');
    else if (capability === 'signal') proc.kill('SIGCONT');
  } catch (err) {
    log.warn(`[throttle] resume failed: ${(err as Error).message}`);
  }
}

/** One-time boot probe (fire-and-forget, like the codec probes): confirms
 *  the bundled ffmpeg really freezes production on stdin `p` and picks back
 *  up on `u`, rather than trusting the build to have the feature. Falls back
 *  to POSIX SIGSTOP/SIGCONT; without either (a Windows build whose stdin key
 *  handling needs a real console, not a redirected pipe) throttling stays off. */
export async function detectPauseCapability(log: Logger): Promise<void> {
  if (probed) return;
  probed = true;
  const t0 = Date.now();
  const stdinWorks = await probeStdinPause().catch(() => false);
  capability = stdinWorks ? 'stdin' : process.platform === 'win32' ? 'none' : 'signal';
  if (capability === 'none') {
    log.warn(
      '[pause-probe] ffmpeg stdin pause unsupported and no POSIX fallback on this platform, streaming throttle stays off',
    );
  }
  log.log(`[pause-probe] capability=${capability} (${Date.now() - t0}ms)`);
}

/** Real encode, real pause: a synthetic 720p run is heavy enough that a
 *  failed pause keeps producing frames for the whole check window, and light
 *  enough this costs ~3s at boot. Two windows after 'p', a drain window for
 *  in-flight frames already queued in the encoder, then a confirm window
 *  that must be flat, tell a real pause apart from one that merely stalled
 *  by luck. */
function probeStdinPause(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error', '-nostats',
          '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
          '-t', '600', '-c:v', 'libx264', '-preset', 'medium',
          '-progress', 'pipe:2', '-f', 'null', '-',
        ],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
    } catch {
      resolve(false);
      return;
    }
    let frames = 0;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      proc.kill('SIGKILL');
      resolve(ok);
    };
    proc.stderr?.on('data', (chunk: Buffer) => {
      const m = /frame=(\d+)/.exec(chunk.toString());
      if (m) frames = parseInt(m[1], 10);
    });
    proc.on('error', () => finish(false));
    timers.push(setTimeout(() => finish(false), 12_000));
    timers.push(
      setTimeout(() => {
        proc.stdin?.write('p');
        timers.push(
          setTimeout(() => {
            const settleFrames = frames;
            timers.push(
              setTimeout(() => {
                if (frames > settleFrames + 3) {
                  finish(false); // still producing: the key did nothing
                  return;
                }
                proc.stdin?.write('u');
                timers.push(setTimeout(() => finish(frames > settleFrames), 1000));
              }, 1500),
            );
          }, 1500),
        );
      }, 900),
    );
  });
}
