import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MENU_LABELS, menuTemplate, parseMenuLabels, type WindowCommands } from './menu-template.ts';

const calls: string[] = [];
let full = false;
const win: WindowCommands = {
  toggleFullscreen: () => calls.push('fs'),
  isFullscreen: () => full,
  minimize: () => calls.push('min'),
  zoom: () => calls.push('zoom'),
  close: () => calls.push('close'),
};

const items = (menu: ReturnType<typeof menuTemplate>, label: string) =>
  (menu.find((m) => m.label === label)?.submenu ?? []) as Electron.MenuItemConstructorOptions[];
const press = (i: Electron.MenuItemConstructorOptions | undefined) => i?.click?.(null as never, undefined, null as never);

test('window items act on the framed window', () => {
  const menu = menuTemplate('Fliks', DEFAULT_MENU_LABELS, win, false);
  for (const label of ['Minimize', 'Zoom', 'Close Window']) press(items(menu, 'Window').find((i) => i.label === label));
  press(items(menu, 'View')[0]);
  assert.deepEqual(calls, ['min', 'zoom', 'close', 'fs']);
});

test('the full-screen label follows the window and DevTools stay out of packaged builds', () => {
  full = true;
  const view = items(menuTemplate('Fliks', DEFAULT_MENU_LABELS, win, false), 'View');
  assert.equal(view[0].label, 'Exit Full Screen');
  assert.equal(view.length, 1);
  assert.ok(items(menuTemplate('Fliks', DEFAULT_MENU_LABELS, win, true), 'View').some((i) => i.role === 'toggleDevTools'));
});

test('labels must be complete', () => {
  assert.deepEqual(parseMenuLabels(DEFAULT_MENU_LABELS), DEFAULT_MENU_LABELS);
  assert.equal(parseMenuLabels({ ...DEFAULT_MENU_LABELS, quit: '' }), null);
  assert.equal(parseMenuLabels({}), null);
});

test('the Playback menu follows the player and is inert with nothing loaded', () => {
  const calls: string[] = [];
  let playing: boolean | null = null;
  const playback = {
    playing: () => playing,
    toggle: () => calls.push('toggle'),
    stop: () => calls.push('stop'),
    skip: (s: number) => calls.push(`skip ${s}`),
    next: () => calls.push('next'),
    previous: () => calls.push('previous'),
  };
  const menu = () => items(menuTemplate('Fliks', DEFAULT_MENU_LABELS, null, false, playback), 'Playback');
  assert.ok(menu().filter((i) => i.type !== 'separator').every((i) => i.enabled === false));
  playing = true;
  assert.equal(menu()[0].label, 'Pause');
  playing = false;
  const m = menu();
  assert.equal(m[0].label, 'Play');
  for (const i of m) (i.click as (() => void) | undefined)?.();
  assert.deepEqual(calls, ['toggle', 'stop', 'skip -10', 'skip 10', 'previous', 'next']);
});
