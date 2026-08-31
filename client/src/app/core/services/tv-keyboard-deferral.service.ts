import { DestroyRef, Injectable, inject } from '@angular/core';
import { DeviceService } from './device.service';

/** Text-entry fields the TV's on-screen keyboard pops up for. */
const TEXT_ENTRY =
  'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="password"], input[type="email"], input[type="url"], input[type="tel"], input[type="number"]';

/** Marks a `readonly` we added, so a genuinely read-only field is left alone. */
const DEFERRED = 'data-tv-keyboard-deferred';

/**
 * On TV, merely focusing a text field pops the system keyboard over the whole
 * screen — so walking a form with the D-pad becomes a fight to dismiss it. The
 * field is held `readonly` while focused, which the WebView takes as "nothing
 * to type here", and released on the deliberate press (Enter / OK / click)
 * that actually means the user wants to type.
 *
 * Document-level so it covers every field in the app without each form opting
 * in, and inert on any other form factor.
 */
@Injectable({ providedIn: 'root' })
export class TvKeyboardDeferralService {
  private readonly device = inject(DeviceService);
  private readonly destroyRef = inject(DestroyRef);

  init(): void {
    if (typeof document === 'undefined' || !this.device.isTv()) return;

    const defer = (e: FocusEvent) => this.hold(e.target as HTMLElement | null);
    const release = (e: Event) => this.release(e.target as HTMLElement | null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') this.release(e.target as HTMLElement | null);
    };

    document.addEventListener('focusin', defer, true);
    document.addEventListener('click', release, true);
    document.addEventListener('keydown', onKey, true);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('focusin', defer, true);
      document.removeEventListener('click', release, true);
      document.removeEventListener('keydown', onKey, true);
    });
  }

  private hold(el: HTMLElement | null): void {
    if (!el?.matches?.(TEXT_ENTRY)) return;
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    if (field.readOnly) return; // the field is read-only on its own terms
    field.readOnly = true;
    field.setAttribute(DEFERRED, '');
  }

  private release(el: HTMLElement | null): void {
    const field = el?.closest?.<HTMLInputElement>(`[${DEFERRED}]`);
    if (!field) return;
    field.removeAttribute(DEFERRED);
    field.readOnly = false;
    // Re-focus so the WebView re-evaluates the field and raises the keyboard.
    field.focus();
  }
}
