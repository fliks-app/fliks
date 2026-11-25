import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-notify-'));
const app = Object.assign(new EventEmitter(), {
  getPath: () => userData,
  getName: () => 'Fliks',
  setBadgeCount: () => true,
  quit: mock.fn(),
});
const handlers = new Map<string, (...a: unknown[]) => unknown>();
class Tray {
  setToolTip() {}
  setContextMenu() {}
  on() {}
  destroy() {}
}
mock.module('electron', {
  namedExports: {
    app,
    autoUpdater: new EventEmitter(),
    ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
    Menu: { buildFromTemplate: (t: unknown) => t },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }), createFromBitmap: () => ({}) },
    net: {},
    Notification: class {
      static isSupported = () => false;
    },
    Tray,
    shell: { openExternal: async () => undefined },
  },
});
const { Notifier } = await import('./index.ts');

const setPrefs = (patch: object) => handlers.get('notify:setPrefs')!({}, patch) as Promise<{ background: boolean }>;
const host = () => {
  const calls: string[] = [];
  return { calls, show: () => calls.push('show'), hide: () => calls.push('hide'), sendToPage: () => {} };
};

test('background needs a tray: no icon or no tray host keeps it off', async () => {
  const noIcon = new Notifier(undefined, async () => true);
  await noIcon.attach(host());
  assert.equal((await setPrefs({ background: true })).background, false);
  assert.equal(noIcon.hideOnClose(), false);

  const noHost = new Notifier('/icon.png', async () => false);
  await noHost.attach(host());
  assert.equal((await setPrefs({ background: true })).background, false);
  assert.equal(noHost.hideOnClose(), false);
});

test('with a tray, closing hides, until the app really quits', async () => {
  const n = new Notifier('/icon.png', async () => true);
  const h = host();
  await n.attach(h);
  assert.equal((await setPrefs({ background: true })).background, true);
  assert.equal(n.hideOnClose(), true);
  n.requestClose();
  assert.deepEqual(h.calls, ['hide']);
  app.emit('before-quit');
  assert.equal(n.hideOnClose(), false);
});

test('quit on close is kept on macOS only', async () => {
  const n = new Notifier('/icon.png', async () => true);
  await n.attach(host());
  const set = (on: boolean) => setPrefs({ quitOnClose: on }) as Promise<{ quitOnClose?: boolean }>;
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: real === 'darwin' ? 'linux' : real });
  try {
    assert.equal((await set(true)).quitOnClose, undefined);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    assert.equal((await set(true)).quitOnClose, true);
    assert.equal(n.quitOnClose(), true);
  } finally {
    Object.defineProperty(process, 'platform', { value: real });
  }
});

test('a second launch brings the window back', async () => {
  const n = new Notifier('/icon.png', async () => true);
  const h = host();
  await n.attach(h);
  app.emit('second-instance');
  assert.ok(h.calls.includes('show'));
});
