import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MENU_LABELS, menuTemplate, parseMenuLabels } from './menu-template.ts';

const items = (menu: ReturnType<typeof menuTemplate>, label: string) =>
  (menu.find((m) => m.label === label)?.submenu ?? []) as Electron.MenuItemConstructorOptions[];
const press = (i: Electron.MenuItemConstructorOptions | undefined) => i?.click?.(null as never, undefined, null as never);

test('the full-screen label follows the window and DevTools stay out of packaged builds', () => {
  assert.equal(items(menuTemplate('Fliks', DEFAULT_MENU_LABELS, false, false), 'View')[0].label, 'Enter Full Screen');
  const view = items(menuTemplate('Fliks', DEFAULT_MENU_LABELS, true, false), 'View');
  assert.equal(view[0].label, 'Exit Full Screen');
  assert.equal(view.length, 1);
  assert.ok(items(menuTemplate('Fliks', DEFAULT_MENU_LABELS, true, true), 'View').some((i) => i.role === 'toggleDevTools'));
});

test('labels must be complete', () => {
  assert.deepEqual(parseMenuLabels(DEFAULT_MENU_LABELS), DEFAULT_MENU_LABELS);
  assert.equal(parseMenuLabels({ ...DEFAULT_MENU_LABELS, quit: '' }), null);
  assert.equal(parseMenuLabels({}), null);
});

test('the Playback menu sends the media keys the page handles', () => {
  const keys: string[] = [];
  assert.ok(items(menuTemplate('Fliks', DEFAULT_MENU_LABELS, false, false), 'Playback').every((i) => i.type === 'separator' || i.enabled === false));
  const menu = items(menuTemplate('Fliks', DEFAULT_MENU_LABELS, false, false, (k) => keys.push(k)), 'Playback');
  for (const i of menu) press(i);
  assert.deepEqual(keys, ['MediaPlayPause', 'MediaStop', 'MediaPreviousTrack', 'MediaNextTrack']);
});
