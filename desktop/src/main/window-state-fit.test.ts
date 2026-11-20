import assert from 'node:assert/strict';
import test from 'node:test';
import { fitToDisplays, parseWindowState } from './window-state-fit.ts';

const screen = { x: 0, y: 0, width: 1920, height: 1080 };

test('a window on a display is kept', () => {
  assert.deepEqual(fitToDisplays({ x: 100, y: 80, width: 1280, height: 800 }, [screen]), { x: 100, y: 80, width: 1280, height: 800 });
});

test('a window left on an unplugged display is dropped', () => {
  assert.equal(fitToDisplays({ x: 2500, y: 80, width: 1280, height: 800 }, [screen]), null);
  assert.equal(fitToDisplays({ x: 1900, y: 80, width: 1280, height: 800 }, [screen]), null);
});

test('a window on a second display is kept while it is plugged', () => {
  const second = { x: 1920, y: 0, width: 1920, height: 1080 };
  assert.notEqual(fitToDisplays({ x: 2500, y: 80, width: 1280, height: 800 }, [screen, second]), null);
});

test('a malformed file is ignored', () => {
  assert.equal(parseWindowState({ x: 'a' }), null);
  assert.equal(parseWindowState({ x: 0, y: 0, width: 0, height: 5 }), null);
  assert.equal(parseWindowState(null), null);
  assert.deepEqual(parseWindowState({ x: 1, y: 2, width: 3, height: 4, maximized: true }), { x: 1, y: 2, width: 3, height: 4, maximized: true, fullscreen: false });
});
