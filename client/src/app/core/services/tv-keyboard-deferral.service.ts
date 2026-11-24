import { DestroyRef, Injectable, inject } from '@angular/core';
import { DeviceService } from './device.service';

/** Text-entry fields the TV's on-screen keyboard pops up for. */
const TEXT_ENTRY =
  'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="password"], input[type="email"], input[type="url"], input[type="tel"], input[type="number"]';

/** Marks a `readonly` we added, so a genuinely read-only field is left alone. */
const DEFERRED = 'data-tv-keyboard-deferred';

/** On TV a focused text field pops the system keyboard, so it is held `readonly` while focused and released on a deliberate press (Enter/OK/click).
 * Document-level so every field is covered without opt-in; inert on other form factors. */
@Injectable({ providedIn: 'root' })
export class TvKeyboardDeferralService {
  private readonly device = inject(DeviceService);
  private readonly destroyRef = inject(DestroyRef);

  init(): void {
    if (typeof document === 'undefined' || !this.device.isTv()) return;

    const defer = (e: FocusEvent) => this.hold(e.target as HTMLElement | null);
    const release = (e: Event) => this.release(e.target as HTMLElement | null);
    // webOS still sends that press's keypress, whose default submits the form and closes the keyboard just raised.
    let swallowKeypress = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      // That press meant "let me type", so it must not also reach the form and
      // submit it: the field only just became writable. In a field being typed in, the keyboard's
      // Enter means "done typing": the remote then moves on to the next field or the button.
      const target = e.target as HTMLElement | null;
      if (this.release(target) || this.endTyping(target)) {
        e.preventDefault();
        e.stopPropagation();
        swallowKeypress = true;
      }
    };
    const onKeypress = (e: KeyboardEvent) => {
      if (!swallowKeypress || e.key !== 'Enter') return;
      swallowKeypress = false;
      e.preventDefault();
      e.stopPropagation();
    };
    const onKeyup = () => (swallowKeypress = false);

    // Android TV's keyboard overlays the WebView without shrinking it (MainActivity's `ime` reports height 0).
    const onIme = (e: Event) => {
      const { visible } = (e as CustomEvent<{ visible: boolean }>).detail;
      document.documentElement.classList.toggle('tv-ime-open', visible);
      if (visible) document.activeElement?.scrollIntoView({ block: 'nearest' });
    };

    document.addEventListener('focusin', defer, true);
    document.addEventListener('click', release, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keypress', onKeypress, true);
    document.addEventListener('keyup', onKeyup, true);
    addEventListener('ime', onIme);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('focusin', defer, true);
      document.removeEventListener('click', release, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keypress', onKeypress, true);
      document.removeEventListener('keyup', onKeyup, true);
      removeEventListener('ime', onIme);
    });
  }

  private hold(el: HTMLElement | null): void {
    if (!el?.matches?.(TEXT_ENTRY)) return;
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    if (field.readOnly) return; // the field is read-only on its own terms
    field.readOnly = true;
    field.setAttribute(DEFERRED, '');
  }

  /** Closes the keyboard of a field being typed in by holding it again. A textarea keeps Enter for its new lines,
   *  and a field whose `enterkeyhint` names an action (search, go, send) keeps it for that action. */
  private endTyping(el: HTMLElement | null): boolean {
    if (!el?.matches?.(TEXT_ENTRY) || el instanceof HTMLTextAreaElement || (el as HTMLInputElement).readOnly) return false;
    if (['search', 'go', 'send'].includes(el.getAttribute('enterkeyhint') ?? '')) return false;
    el.blur();
    el.focus();
    return true;
  }

  /** True when a held field was actually released, so the caller knows the
   *  press was spent on raising the keyboard. */
  private release(el: HTMLElement | null): boolean {
    const field = el?.closest?.<HTMLInputElement>(`[${DEFERRED}]`);
    if (!field) return false;
    field.removeAttribute(DEFERRED);
    field.readOnly = false;
    // Re-focus so the WebView re-evaluates the field and raises the keyboard.
    field.focus();
    return true;
  }
}
