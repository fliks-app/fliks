import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

let supported = true;
const openExternal = mock.fn(async (_url: string) => undefined);
mock.module('electron', {
  namedExports: { Notification: { isSupported: () => supported }, shell: { openExternal } },
});
const { notifyStatus, openNotifySettings } = await import('./status.ts');

const addon = (a: object) => async () => a;

test('Windows: only an enabled toast setting is allowed', async () => {
  assert.equal(await notifyStatus(addon({ notifySetting: () => 'enabled' }), 'win32'), 'allowed');
  for (const s of ['app', 'user', 'policy', 'manifest']) {
    assert.equal(await notifyStatus(addon({ notifySetting: () => s }), 'win32'), 'blocked');
  }
});

test('Windows: the setting is read for the app id the shell registers', async () => {
  const notifySetting = mock.fn((_id: string) => 'enabled');
  await notifyStatus(addon({ notifySetting }), 'win32');
  assert.equal(notifySetting.mock.calls[0].arguments[0], 'media.fliks.desktop');
});

test('macOS: denied is blocked, undetermined is left to the first notification', async () => {
  assert.equal(await notifyStatus(addon({ notifyAuthorization: () => 'denied' }), 'darwin'), 'blocked');
  assert.equal(await notifyStatus(addon({ notifyAuthorization: () => 'undetermined' }), 'darwin'), 'allowed');
  assert.equal(await notifyStatus(addon({ notifyAuthorization: () => 'allowed' }), 'darwin'), 'allowed');
});

test('an unreadable setting counts as allowed', async () => {
  const failing = addon({ notifySetting: () => { throw new Error('Element not found.'); } });
  assert.equal(await notifyStatus(failing, 'win32'), 'allowed');
  assert.equal(await notifyStatus(async () => null, 'linux'), 'allowed');
});

test('no notification service is unavailable', async () => {
  supported = false;
  assert.equal(await notifyStatus(addon({ notifySetting: () => 'enabled' }), 'win32'), 'unavailable');
  supported = true;
});

test('opens the notification settings of the OS, none on Linux', async () => {
  await openNotifySettings('win32');
  await openNotifySettings('darwin');
  await openNotifySettings('linux');
  assert.deepEqual(
    openExternal.mock.calls.map((c) => c.arguments[0]),
    ['ms-settings:notifications', 'x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=media.fliks.desktop'],
  );
});
