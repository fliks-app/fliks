/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- child_process stand-in */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { promisify } from 'util';

/** What a tool printed, or how it failed. */
export interface ToolResult {
  stdout: string;
  stderr: string;
  fail?: { code?: number | string; killed?: boolean; enoent?: boolean };
}

/** One tool run as the service issued it. */
export interface Call extends ToolResult {
  cmd: string;
  args: string[];
  /** A streamed run the service ended early: it read no further than `stdout`. */
  stopped?: boolean;
}

export type Backend = (cmd: string, args: string[]) => Promise<ToolResult>;

/** Shared state of the child_process stand-in; the spec sets `backend` per case. */
export const io = {
  backend: undefined as Backend | undefined,
  log: [] as Call[],
  fileSize: 0,
};

const base = (cmd: string) => cmd.split('/').pop() ?? cmd;

/** `execFile`'s own failure text. */
const message = (cmd: string, args: string[], r: ToolResult) =>
  r.fail?.enoent
    ? `spawn ${cmd} ENOENT`
    : `Command failed: ${[cmd, ...args].join(' ')}\n${r.stderr}`;

function failure(cmd: string, args: string[], r: ToolResult) {
  return Object.assign(new Error(message(cmd, args, r)), {
    code: r.fail?.enoent ? 'ENOENT' : (r.fail?.code ?? 1),
    killed: r.fail?.killed ?? false,
    stdout: r.stdout,
    stderr: r.stderr,
  });
}

/** `execFile` and `spawn` that run the backend instead of a process. A spawn feeds its stdout
 *  one line per tick and stops at `kill`, so the log keeps exactly the lines the service read. */
export function childProcessMock(actual: object) {
  const run = async (cmd: string, args: string[]) => {
    const call: Call = {
      cmd: base(cmd),
      args: [...args],
      stdout: '',
      stderr: '',
    };
    io.log.push(call);
    const r = await io.backend!(call.cmd, call.args);
    Object.assign(call, r);
    return { call, r };
  };

  const execFile: any = (
    cmd: string,
    args: string[],
    opts: unknown,
    cb?: any,
  ) => {
    const done = typeof opts === 'function' ? opts : cb;
    run(cmd, args).then(
      ({ r }) =>
        r.fail
          ? done(failure(cmd, args, r), r.stdout, r.stderr)
          : done(null, r.stdout, r.stderr),
      (e) => done(e),
    );
  };
  execFile[promisify.custom] = async (cmd: string, args: string[]) => {
    const { r } = await run(cmd, args);
    if (r.fail) throw failure(cmd, args, r);
    return { stdout: r.stdout, stderr: r.stderr };
  };

  const spawn = (cmd: string, args: string[]) => {
    const proc: any = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();
    let killed = false;
    proc.kill = () => (killed = true);
    void (async () => {
      const call: Call = {
        cmd: base(cmd),
        args: [...args],
        stdout: '',
        stderr: '',
      };
      io.log.push(call);
      const r = await io.backend!(call.cmd, call.args);
      if (r.fail?.enoent) {
        proc.emit('error', failure(cmd, args, r));
        return;
      }
      call.stderr = r.stderr;
      if (r.fail) call.fail = r.fail;
      const lines = r.stdout.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      for (const line of lines) {
        if (killed) break;
        call.stdout += line + '\n';
        proc.stdout.write(line + '\n');
        await new Promise((res) => setImmediate(res));
      }
      if (killed) call.stopped = true;
      proc.stderr.write(r.stderr);
      proc.stdout.end();
      await new Promise((res) => setImmediate(res));
      proc.emit('close', killed ? null : r.fail ? (r.fail.code ?? 1) : 0);
    })();
    return proc;
  };

  return { ...actual, execFile, spawn };
}
