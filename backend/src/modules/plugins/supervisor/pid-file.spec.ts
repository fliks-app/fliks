import { spawn, type ChildProcess } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { pidFilePath, removePidFile, sweepOrphans, writePidFile } from './pid-file';
import { makeRuntimeDir } from './supervisor-test-helpers';

function spawnDecoy(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('pid-file / sweepOrphans', () => {
  const runtimeDirs: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const c of children) {
      if (!c.killed) c.kill('SIGKILL');
    }
    children.length = 0;
    for (const d of runtimeDirs) rmSync(d, { recursive: true, force: true });
    runtimeDirs.length = 0;
  });

  it('writes and removes a pid file', () => {
    const runtimeDir = makeRuntimeDir();
    runtimeDirs.push(runtimeDir);
    writePidFile(runtimeDir, 'demo', 12345, [process.execPath, '-e', '0']);
    expect(existsSync(pidFilePath(runtimeDir, 'demo'))).toBe(true);
    removePidFile(runtimeDir, 'demo');
    expect(existsSync(pidFilePath(runtimeDir, 'demo'))).toBe(false);
  });

  it('kills a live process whose recorded cmdline matches, real spawn and real kill', async () => {
    const runtimeDir = makeRuntimeDir();
    runtimeDirs.push(runtimeDir);
    const argv = [process.execPath, '-e', 'setTimeout(() => {}, 30000)'];
    const decoy = spawnDecoy();
    children.push(decoy);
    await new Promise((r) => setTimeout(r, 50));

    writePidFile(runtimeDir, 'orphan', decoy.pid!, argv);
    sweepOrphans(runtimeDir);
    await new Promise((r) => setTimeout(r, 100));

    expect(isAlive(decoy.pid!)).toBe(false);
    expect(existsSync(pidFilePath(runtimeDir, 'orphan'))).toBe(false);
  }, 10_000);

  it('leaves a live process alone when the recorded cmdline does not match', async () => {
    const runtimeDir = makeRuntimeDir();
    runtimeDirs.push(runtimeDir);
    const innocent = spawnDecoy();
    children.push(innocent);
    await new Promise((r) => setTimeout(r, 50));

    writePidFile(runtimeDir, 'not-orphan', innocent.pid!, [process.execPath, '-e', 'totally different argv']);
    sweepOrphans(runtimeDir);
    await new Promise((r) => setTimeout(r, 100));

    expect(isAlive(innocent.pid!)).toBe(true);
  }, 10_000);

  it('cleans up a pid file whose process is already dead', () => {
    const runtimeDir = makeRuntimeDir();
    runtimeDirs.push(runtimeDir);
    // A pid essentially guaranteed not to be alive right now.
    writePidFile(runtimeDir, 'dead', 999_999, [process.execPath]);
    sweepOrphans(runtimeDir);
    expect(existsSync(pidFilePath(runtimeDir, 'dead'))).toBe(false);
  });
});
