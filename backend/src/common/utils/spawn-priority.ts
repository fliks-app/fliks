import { spawn, type ChildProcess, type StdioOptions } from 'child_process';
import type { Readable } from 'stream';

/** `ionice -c3`/`nice -n19` ahead of `cmd` when `background` and the platform
 *  supports it (Linux only); the bare command otherwise. */
export function spawnBackground(
  cmd: string,
  args: string[],
  opts: { background?: boolean; io?: boolean; cpu?: boolean; stdio?: StdioOptions },
): ChildProcess {
  const prefix: string[] = [];
  if (opts.background && process.platform === 'linux') {
    if (opts.io) prefix.push('ionice', '-c3');
    if (opts.cpu) prefix.push('nice', '-n19');
  }
  const [head, ...rest] = prefix.length ? prefix : [cmd];
  return spawn(head, prefix.length ? [...rest, cmd, ...args] : args, { stdio: opts.stdio });
}

/** A process's stderr, kept to its last `n` characters. */
export function collectStderrTail(stream: Readable, n: number): { get(): string } {
  let tail = '';
  stream.on('data', (d: Buffer) => (tail = (tail + d.toString()).slice(-n)));
  return { get: () => tail };
}
