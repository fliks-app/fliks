import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceService } from './device.service';
import { TvKeyboardDeferralService } from './tv-keyboard-deferral.service';

/** On webOS the OK press that raised the keyboard also sent its keypress, which submitted the form and closed it;
 *  the keyboard's own Enter submitted it too, when the viewer only meant to move on to the next field. */
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

  it("ends typing on the keyboard's Enter: the field is held again and the form is not submitted", () => {
    const input = field();
    press(input, 'keydown');
    press(input, 'keyup');
    expect(press(input, 'keydown').defaultPrevented).toBe(true);
    expect(press(input, 'keypress').defaultPrevented).toBe(true);
    expect(input.readOnly).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('leaves Enter to a field that names its action, a search box', () => {
    const input = field();
    input.setAttribute('enterkeyhint', 'search');
    press(input, 'keydown');
    press(input, 'keyup');
    expect(press(input, 'keydown').defaultPrevented).toBe(false);
  });

  it('leaves Enter to a textarea, for its new lines', () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: DeviceService, useValue: { isTv: () => true } }],
    });
    TestBed.inject(TvKeyboardDeferralService).init();
    document.body.innerHTML = '<textarea></textarea>';
    const area = document.querySelector('textarea')!;
    area.focus();
    press(area, 'keydown');
    press(area, 'keyup');
    expect(press(area, 'keydown').defaultPrevented).toBe(false);
  });
});
