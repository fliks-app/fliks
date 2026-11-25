import { afterEach, describe, expect, it } from 'vitest';
import { installTapOutsideBlur } from './tap-outside-blur';

describe('installTapOutsideBlur', () => {
  installTapOutsideBlur();
  afterEach(() => (document.body.innerHTML = ''));

  function tap(target: Element) {
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  }

  it('blurs a focused field on a tap on the page, not in its form or on a control', () => {
    document.body.innerHTML =
      '<form><input id="a"><div id="gap"></div></form><div id="out"></div><button id="b">b</button><label id="l">l</label>';
    const input = document.getElementById('a') as HTMLInputElement;
    input.focus();
    for (const id of ['gap', 'b', 'l']) {
      tap(document.getElementById(id)!);
      expect(document.activeElement).toBe(input);
    }
    tap(document.getElementById('out')!);
    expect(document.activeElement).not.toBe(input);
  });

  it('leaves a focused checkbox alone', () => {
    document.body.innerHTML = '<input id="c" type="checkbox"><div id="out"></div>';
    const box = document.getElementById('c') as HTMLInputElement;
    box.focus();
    tap(document.getElementById('out')!);
    expect(document.activeElement).toBe(box);
  });
});
