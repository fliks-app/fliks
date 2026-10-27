import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceService } from '../../core/services/device.service';
import { ControlsVisibilityService } from './controls/controls-visibility';
import { KeyboardController, type KeyboardHost } from './keyboard-controller';

describe('KeyboardController layers', () => {
  let chrome: ControlsVisibilityService;
  let reactions: boolean;
  const openReactions = vi.fn();

  function controller(): KeyboardController {
    const host = {
      chrome,
      engine: () => ({ currentTime: 10, paused: false }),
      controls: () => undefined,
      isTv: () => false,
      canControlPlayback: () => true,
      playbackRate: () => 1,
      reactionsAvailable: () => reactions,
      openReactions: () => {
        openReactions();
        chrome.showReactions();
      },
    } as unknown as KeyboardHost;
    return new KeyboardController(host);
  }
  const press = (key: string) => {
    const e = new KeyboardEvent('keydown', { key, cancelable: true });
    Object.defineProperty(e, 'target', { value: document.body });
    return e;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ControlsVisibilityService,
        { provide: DeviceService, useValue: { isTv: () => false, isTouch: () => false, isDpad: () => false } },
      ],
    });
    chrome = TestBed.inject(ControlsVisibilityService);
    chrome.hide();
    reactions = true;
    openReactions.mockClear();
  });
  afterEach(() => document.querySelectorAll('dialog').forEach((d) => d.remove()));

  it('raises the controls on ArrowUp and the reaction row alone on ArrowDown', () => {
    const k = controller();
    k.onKeyDown(press('ArrowDown'));
    expect(openReactions).toHaveBeenCalledOnce();
    expect([chrome.visible(), chrome.reactionsOnly()]).toEqual([false, true]);
    k.onKeyDown(press('ArrowUp'));
    expect([chrome.visible(), chrome.reactionsOnly()]).toEqual([true, false]);
  });

  it('falls back to the controls on ArrowDown outside a reacting party', () => {
    reactions = false;
    controller().onKeyDown(press('ArrowDown'));
    expect(openReactions).not.toHaveBeenCalled();
    expect(chrome.visible()).toBe(true);
  });

  it('closes the reaction row on Escape without leaving the player', () => {
    const k = controller();
    k.onKeyDown(press('ArrowDown'));
    const e = press('Escape');
    k.onKeyDown(e);
    expect([chrome.visible(), chrome.reactionsOnly()]).toEqual([false, false]);
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves the keys of an open dialog alone', () => {
    const dialog = document.createElement('dialog');
    const button = document.createElement('button');
    dialog.append(button);
    document.body.append(dialog);
    dialog.setAttribute('open', '');
    button.focus();
    const e = press('ArrowDown');
    controller().onKeyDown(e);
    expect(e.defaultPrevented).toBe(false);
    expect(chrome.reactionsOnly()).toBe(false);
  });
});
