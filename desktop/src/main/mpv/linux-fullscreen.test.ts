import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesktopEvent } from '../../shared/contract.ts';
import { linuxFullscreen } from './linux-fullscreen.ts';

function setup() {
  let windowFullscreen = false;
  const requests: boolean[] = [];
  const source = {
    onFullscreenChange: undefined as ((f: boolean) => void) | undefined,
    setFullscreen: (on: boolean) => void requests.push(on),
    isFullscreen: () => windowFullscreen,
  };
  const sent: DesktopEvent[] = [];
  const fs = linuxFullscreen(source, (ev) => void sent.push(ev));
  return { fs, requests, sent, sdl: (on: boolean) => { windowFullscreen = on; source.onFullscreenChange?.(on); } };
}

test('a request emits nothing and the answer stays windowed until SDL reports the change', () => {
  const t = setup();
  t.fs.set(true);
  assert.deepEqual(t.requests, [true]);
  assert.deepEqual(t.sent, []);
  assert.equal(t.fs.get(), false);
});

test('the event and the answer follow SDL, including a change the window manager makes', () => {
  const t = setup();
  t.sdl(true);
  assert.equal(t.fs.get(), true);
  t.sdl(false);
  assert.equal(t.fs.get(), false);
  assert.deepEqual(t.sent, [
    { type: 'fullscreenChanged', payload: { fullscreen: true } },
    { type: 'fullscreenChanged', payload: { fullscreen: false } },
  ]);
});
