import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceService } from './device.service';
import { TvKeyboardDeferralService } from './tv-keyboard-deferral.service';

/** On webOS the OK press that raised the keyboard also sent its keypress, which submitted the form and closed it. */
describe('TvKeyboardDeferralService', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    TestBed.resetTestingModule();
  });

  function field(): HTMLInputElement {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: DeviceService, useValue: { isTv: () => true } }],
    });
    TestBed.inject(TvKeyboardDeferralService).init();
    document.body.innerHTML = '<form><input type="url" name="serverUrl" /><button type="submit">Go</button></form>';
    const input = document.querySelector('input')!;
    input.focus();
    return input;
  }

  const press = (el: HTMLElement, type: 'keydown' | 'keypress' | 'keyup') => {
    const e = new KeyboardEvent(type, { key: 'Enter', bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };

  it('holds a focused field and releases it on Enter, spending that press', () => {
    const input = field();
    expect(input.readOnly).toBe(true);
    expect(press(input, 'keydown').defaultPrevented).toBe(true);
    expect(input.readOnly).toBe(false);
  });

  it("swallows the releasing press's keypress, which would submit the form", () => {
    const input = field();
    press(input, 'keydown');
    expect(press(input, 'keypress').defaultPrevented).toBe(true);
  });

  it('lets the next Enter through once the field is writable', () => {
    const input = field();
    press(input, 'keydown');
    press(input, 'keyup');
    expect(press(input, 'keydown').defaultPrevented).toBe(false);
    expect(press(input, 'keypress').defaultPrevented).toBe(false);
  });
});
