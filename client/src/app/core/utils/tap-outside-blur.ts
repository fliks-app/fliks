import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { FOCUSABLE_SELECTOR } from '../services/focusable.constants';

const TEXT_FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, [contenteditable="true"]';

/** A WebView keeps a text field focused, keyboard up, on a tap outside it: such a tap blurs it,
 *  unless it lands in the field's form or on a control (UIKit leaves the keyboard up for those too). */
export function installTapOutsideBlur(doc: Document = document): void {
  doc.addEventListener(
    'pointerdown',
    (e) => {
      const active = doc.activeElement as HTMLElement | null;
      const target = e.target as Element | null;
      if (!active?.matches(TEXT_FIELD) || !target) return;
      if (active.closest('form')?.contains(target) || target.closest(`${FOCUSABLE_SELECTOR}, label`)) return;
      active.blur();
      if (Capacitor.isNativePlatform()) Keyboard.hide().catch(() => {});
    },
    { capture: true },
  );
}
