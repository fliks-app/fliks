import { createInterface } from 'readline';
import type { Readable } from 'stream';
import { spawnBackground, collectStderrTail } from './spawn-priority';

/** Run ffprobe line by line; `onLine` returning false ends it early. With
 *  `input`, ffprobe reads it on stdin in place of the path in `args`. */
export function ffprobeLines(
  args: string[],
  onLine: (line: string) => boolean,
  opts: { timeoutMs: number; background?: boolean; input?: Readable },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawnBackground('ffprobe', args, { background: opts.background, io: true, cpu: true });
    const stderr = collectStderrTail(proc.stderr!, 2000);
    let stopped = false;
    const stop = () => {
      stopped = true;
      proc.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`ffprobe timed out after ${opts.timeoutMs} ms`));
    }, opts.timeoutMs);
    if (opts.input) {
      // A read ended early closes the pipe under the writer: EPIPE, not a failure.
      proc.stdin!.on('error', () => {});
      opts.input.on('error', (err) => {
        stop();
        reject(err);
      });
      opts.input.pipe(proc.stdin!);
    }
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      if (!stopped && line && !onLine(line)) stop();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (stopped || code === 0) resolve();
      else reject(new Error(`ffprobe exited ${code}: ${stderr.get().trim()}`));
    });
  });
}
