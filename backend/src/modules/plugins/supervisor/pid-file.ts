import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

interface PidFileContents {
  pid: number;
  cmdline: string[];
}

export function pidFilePath(runtimeDir: string, pluginId: string): string {
  return join(runtimeDir, `${pluginId}.pid`);
}

export function writePidFile(runtimeDir: string, pluginId: string, pid: number, cmdline: string[]): void {
  mkdirSync(runtimeDir, { recursive: true });
  const entry: PidFileContents = { pid, cmdline };
  writeFileSync(pidFilePath(runtimeDir, pluginId), JSON.stringify(entry));
}

export function removePidFile(runtimeDir: string, pluginId: string): void {
  try {
    unlinkSync(pidFilePath(runtimeDir, pluginId));
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Linux only: argv as the kernel recorded it, NUL-separated. Null if unreadable (e.g. not Linux, or gone). */
function readCmdline(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\0')
      .filter((s) => s.length > 0);
  } catch {
    return null;
  }
}

function cmdlineMatches(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Kills any live process whose pid file matches its expected cmdline — a true no-op in Docker
 *  (SIGKILLing PID 1 tears down the namespace already); exists for Windows/macOS, which leak a plugin child across a crash. */
export function sweepOrphans(runtimeDir: string): void {
  if (!existsSync(runtimeDir)) return;
  for (const file of readdirSync(runtimeDir)) {
    if (!file.endsWith('.pid')) continue;
    const full = join(runtimeDir, file);
    let entry: PidFileContents;
    try {
      entry = JSON.parse(readFileSync(full, 'utf8')) as PidFileContents;
    } catch {
      continue;
    }
    if (!isAlive(entry.pid)) {
      try {
        unlinkSync(full);
      } catch {
        // race with the owning supervisor's own cleanup
      }
      continue;
    }
    const cmdline = readCmdline(entry.pid);
    if (cmdline && cmdlineMatches(cmdline, entry.cmdline)) {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      try {
        unlinkSync(full);
      } catch {
        // already gone
      }
    }
  }
}
