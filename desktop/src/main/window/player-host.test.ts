import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { EventEmitter } from 'node:events';

const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-host-'));
mock.module('electron', {
  namedExports: {
    app: { getPath: () => logs, isPackaged: true },
    powerSaveBlocker: { start: () => 1, stop: () => {}, isStarted: () => false },
  },
});
const { PlayerHost } = await import('./player-host.ts');

class FakeBackend extends EventEmitter {
  started = false;
  destroyed = false;
  async start() {
    this.started = true;
  }
  async stop() {}
  async destroy() {
    this.destroyed = true;
  }
}

function setup(opts: { respawn: boolean; failStart?: boolean }) {
  const backends: FakeBackend[] = [];
  const events: unknown[] = [];
  const host = new PlayerHost({
    create: async () => {
      const b = new FakeBackend();
      if (opts.failStart) b.start = async () => { throw new Error('dlopen failed'); };
      backends.push(b);
      return b as never;
    },
    emit: (e) => void events.push(e),
    respawn: opts.respawn,
  });
  return { host, backends, events };
}

test('whenReady resolves with the started backend', async () => {
  const t = setup({ respawn: false });
  t.host.start();
  const b = (await t.host.whenReady()) as unknown as FakeBackend;
  assert.equal(b.started, true);
});

test('a failed start rejects whenReady with the start error', async () => {
  const t = setup({ respawn: false, failStart: true });
  t.host.start();
  await assert.rejects(t.host.whenReady(), /dlopen failed/);
  assert.equal(t.backends[0]!.destroyed, true);
});

test('a backend that exits is replaced and calls wait for the new one', async () => {
  const t = setup({ respawn: true });
  t.host.start();
  const first = (await t.host.whenReady()) as unknown as FakeBackend;
  first.emit('exit', { code: 1, signal: null });
  const second = (await t.host.whenReady()) as unknown as FakeBackend;
  assert.notEqual(second, first);
  assert.equal(second.started, true);
});

test('an exit is ignored where the backend is in process', async () => {
  const t = setup({ respawn: false });
  t.host.start();
  const first = (await t.host.whenReady()) as unknown as FakeBackend;
  first.emit('exit', { code: 1, signal: null });
  assert.equal(await t.host.whenReady(), first as never);
});

test('restarts stop after three in a minute', async () => {
  const t = setup({ respawn: true });
  t.host.start();
  for (let i = 0; i < 3; i++) {
    const b = (await t.host.whenReady()) as unknown as FakeBackend;
    b.emit('exit', { code: 1, signal: null });
  }
  const last = t.backends.at(-1)!;
  await t.host.whenReady();
  last.emit('exit', { code: 1, signal: null });
  await assert.rejects(t.host.whenReady(), /keeps exiting/);
});

test('windowHidden tells the page; destroy tears the backend down once', async () => {
  const t = setup({ respawn: true });
  t.host.start();
  const b = (await t.host.whenReady()) as unknown as FakeBackend;
  t.host.windowHidden();
  assert.deepEqual(t.events.at(-1), { type: 'windowHidden' });
  await t.host.destroy();
  assert.equal(b.destroyed, true);
  b.emit('exit', { code: 1, signal: null });
  assert.equal(t.backends.length, 1);
});
