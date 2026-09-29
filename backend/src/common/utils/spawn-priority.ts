import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import type { Readable } from 'stream';

type PriorityOpts = { background?: boolean; io?: boolean; cpu?: boolean };

function priorityPrefix(opts: PriorityOpts): string[] {
  const prefix: string[] = [];
  if (opts.background && process.platform === 'linux') {
    if (opts.io) prefix.push('ionice', '-c3');
    if (opts.cpu) prefix.push('nice', '-n19');
  }
  return prefix;
}

/** `ionice -c3`/`nice -n19` ahead of `cmd` when `background` and the platform
 *  supports it (Linux only); the bare command otherwise. */
export function spawnBackground(
  cmd: string,
  args: string[],
  opts: SpawnOptions & PriorityOpts,
): ChildProcess {
  const prefix = priorityPrefix(opts);
  const [head, ...rest] = prefix.length ? prefix : [cmd];
  return spawn(head, prefix.length ? [...rest, cmd, ...args] : args, opts);
}

/** Same priority prefix as `spawnBackground`, for `execFile`-style callers:
 *  returns `[cmd, args]` with the prefix spliced in ahead of `cmd`. */
export function priorityExecFileArgs(
  cmd: string,
  args: string[],
  opts: PriorityOpts,
): [string, string[]] {
  const prefix = priorityPrefix(opts);
  return prefix.length
    ? [prefix[0], [...prefix.slice(1), cmd, ...args]]
    : [cmd, args];
}

/** A process's stderr, kept to its last `n` characters. */
export function collectStderrTail(
  stream: Readable,
  n: number,
): { get(): string } {
  let tail = '';
  stream.on('data', (d: Buffer) => (tail = (tail + d.toString()).slice(-n)));
  return { get: () => tail };
}
