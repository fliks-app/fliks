import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

let supported = true;
const openExternal = mock.fn(async (_url: string) => undefined);
mock.module('electron', {
  namedExports: { Notification: { isSupported: () => supported }, shell: { openExternal } },
});
const { macNotificationsAllowed, notifyStatus, openNotifySettings } = await import('./status.ts');

const addon = (a: object) => async () => a;

test('Windows: only an enabled toast setting is allowed', async () => {
  assert.equal(await notifyStatus(addon({ notifySetting: () => 'enabled' }), 'win32'), 'allowed');
  for (const s of ['app', 'user', 'policy', 'manifest']) {
    assert.equal(await notifyStatus(addon({ notifySetting: () => s }), 'win32'), 'blocked');
  }
  assert.equal(await notifyStatus(addon({ notifySetting: () => 'unknown' }), 'win32'), 'allowed');
});

test('Windows: the setting is read for the app id the shell registers', async () => {
  const notifySetting = mock.fn((_id: string) => 'enabled');
  await notifyStatus(addon({ notifySetting }), 'win32');
  assert.equal(notifySetting.mock.calls[0].arguments[0], 'media.fliks.desktop');
});

test('macOS: denied is blocked, undetermined is left to the first notification', async () => {
  assert.equal(await notifyStatus(addon({ notifyAuthorization: async () => 'denied' }), 'darwin'), 'blocked');
  assert.equal(await notifyStatus(addon({ notifyAuthorization: async () => 'undetermined' }), 'darwin'), 'allowed');
  assert.equal(await notifyStatus(addon({ notifyAuthorization: async () => 'allowed' }), 'darwin'), 'allowed');
});

test('macOS: a daemon that never answers counts as allowed', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const pending = notifyStatus(addon({ notifyAuthorization: () => new Promise(() => {}) }), 'darwin');
  await Promise.resolve();
  await Promise.resolve();
  mock.timers.tick(2000);
  assert.equal(await pending, 'allowed');
  mock.timers.reset();
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

test('macOS badge: only an already allowed app, never an undetermined one', async () => {
  assert.equal(await macNotificationsAllowed(addon({ notifyAuthorization: async () => 'allowed' })), true);
  assert.equal(await macNotificationsAllowed(addon({ notifyAuthorization: async () => 'undetermined' })), false);
  assert.equal(await macNotificationsAllowed(addon({})), false);
  assert.equal(await macNotificationsAllowed(async () => { throw new Error('no addon'); }), false);
});
