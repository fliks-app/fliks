import { Logger } from '@nestjs/common';
import { spawn, type ChildProcess } from 'child_process';

/** How this host's ffmpeg build pauses: `stdin` p/u keys, `signal`
 *  (SIGSTOP/SIGCONT) as a POSIX fallback, or `none` on a Windows build lacking the key. */
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

/** One-time boot probe: confirms the bundled ffmpeg really pauses on stdin
 *  `p`/`u` before relying on it, falling back to SIGSTOP/SIGCONT or off. */
export async function detectPauseCapability(log: Logger): Promise<void> {
  if (probed) return;
  probed = true;
  const t0 = Date.now();
  const stdinWorks = await probeStdinPause(log).catch(() => false);
  capability = stdinWorks ? 'stdin' : process.platform === 'win32' ? 'none' : 'signal';
  if (capability === 'none') {
    log.warn(
      '[pause-probe] ffmpeg stdin pause unsupported and no POSIX fallback on this platform, streaming throttle stays off',
    );
  }
  log.log(`[pause-probe] capability=${capability} (${Date.now() - t0}ms)`);
}

/** `-re` paces a cheap rawvideo run in real time so a failed pause keeps
 *  visibly advancing; a drain window then a flat window tell a real pause
 *  from one that merely stalled by luck. No encoder library required. */
function probeStdinPause(log: Logger): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error', '-nostats',
          '-re', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30',
          '-t', '600', '-c:v', 'rawvideo',
          '-progress', 'pipe:2', '-f', 'null', '-',
        ],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
    } catch {
      resolve(false);
      return;
    }
    proc.stdin?.on('error', (err) => log.debug(`[pause-probe] stdin: ${err.message}`));
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
