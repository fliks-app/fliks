import { mkdtempSync, copyFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { LogBufferService } from '../../scheduler/log-buffer.service';
import type { PluginSupervisor, SupervisorState } from './plugin-supervisor';

// `import * as` wraps named exports as non-configurable getters; jest.spyOn needs the mutable
// module object that `plugin-supervisor.ts` itself requires.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const childProcess: typeof import('child_process') = require('child_process');

/** Not a `.spec.ts` — shared helpers for the supervisor test suite, never run as a suite itself. */

const FIXTURE_SOURCE = join(__dirname, '__fixtures__/fixture-plugin.js');

/** A fresh `dir` with the real fixture plugin at `plugin.js` and its mode file next to it. */
export function makeFixtureDir(mode: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-sup-dir-'));
  copyFileSync(FIXTURE_SOURCE, join(dir, 'plugin.js'));
  writeFileSync(join(dir, 'FIXTURE_MODE'), mode);
  return dir;
}

export function makeRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), 'plugin-sup-rt-'));
}

export function newLogBuffer(): LogBufferService {
  return new LogBufferService();
}

/** Resolves the next time `sup` reaches `target`; rejects (real timer) if it never does. */
export function waitForState(
  sup: PluginSupervisor,
  target: SupervisorState,
  timeoutMs = 3_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (sup.getState() === target) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      off();
      reject(
        new Error(
          `timed out waiting for state "${target}" (currently "${sup.getState()}")`,
        ),
      );
    }, timeoutMs);
    const off = sup.onStateChange((s) => {
      if (s === target) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A real exec failure needs no root and no missing binary to reach: this
 * `ChildProcess`-shaped `EventEmitter` never got a pid at all, matching
 * Node's own contract for a `spawn()` that never executed. One-shot —
 * later calls in the same test hit the real `spawn`.
 */
export function mockFailedSpawn(message: string): jest.SpyInstance {
  return jest.spyOn(childProcess, 'spawn').mockImplementationOnce(() => {
    const fake = new EventEmitter() as unknown as ChildProcess;
    Object.assign(fake, {
      pid: undefined,
      killed: false,
      exitCode: null,
      signalCode: null,
      stdout: null,
      stderr: null,
      kill: () => true,
    });
    queueMicrotask(() => fake.emit('error', new Error(message)));
    return fake;
  });
}

/** `crashed` fires on the kill decision, not the OS's exit confirmation — polls rather than a fixed delay. */
export async function waitForExitSignal(
  sup: { getLastExitSignal(): NodeJS.Signals | null },
  timeoutMs = 2_000,
): Promise<NodeJS.Signals | null> {
  const start = Date.now();
  while (sup.getLastExitSignal() === null && Date.now() - start < timeoutMs) {
    await delay(5);
  }
  return sup.getLastExitSignal();
}
