import { Directive, ElementRef, inject, OnDestroy } from '@angular/core';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';
import {
  TABBABLE_SELECTOR,
  focusOverlayEntry,
  initialOverlayFocus,
  restoreOpenerFocus,
} from '../../core/services/focusable.constants';

/** Click-driven `.dropdown-open` toggle for DaisyUI dropdowns, whose `:focus-within` opening is neutralised globally;
 *  outside clicks and back (DismissableStackService) close it. Usage: `<div appDropdownToggle tabindex="0" role="button">` beside `.dropdown-content`. */

@Directive({
  selector: '[appDropdownToggle]',
  host: {
    '(click)': 'onClick($event)',
    '(keydown)': 'onKey($event)',
  },
})
export class DropdownToggleDirective implements OnDestroy {
  /** Close handler of the open dropdown: opening another closes it first, since the trigger's `stopPropagation` blocks outside-click handlers. */
  private static openClose: (() => void) | null = null;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly dismissStack = inject(DismissableStackService);
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private tabKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private currentClose: (() => void) | null = null;
  /** The focusable element that opened the dropdown — refocused on close so
   *  Enter / Space re-opens it without needing to Tab back. */
  private triggerEl: HTMLElement | null = null;

  ngOnDestroy() {
    this.cleanup();
  }

  protected onClick(event: Event) {
    event.stopPropagation();
    const dropdown = this.host.nativeElement.closest<HTMLElement>('.dropdown');
    if (!dropdown) return;
    const isOpening = !dropdown.classList.contains('dropdown-open');
    if (isOpening) {
      const target = (event.target as HTMLElement | null)
        ?.closest<HTMLElement>('button, a, [tabindex], [role="button"]');
      this.triggerEl = target ?? this.host.nativeElement;
      this.open(dropdown);
    } else {
      this.close();
    }
  }

  /** Enter / Space on a div-based trigger doesn't synthesise a click —
   *  handle it so keyboard activation opens the dropdown. */
  protected onKey(event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.onClick(event);
  }

  private open(dropdown: HTMLElement) {
    // Close any other dropdown already open before opening this one.
    DropdownToggleDirective.openClose?.();

    dropdown.classList.add('dropdown-open');
    const content = dropdown.querySelector<HTMLElement>('.dropdown-content');
    // Focus into the menu so arrows step between items (spatial-nav scopes to `.dropdown-open .dropdown-content`), per the ARIA menu pattern.
    queueMicrotask(() => {
      focusOverlayEntry(initialOverlayFocus(content));
    });
    const close = () => {
      dropdown.classList.remove('dropdown-open');
      restoreOpenerFocus(this.triggerEl);
      this.cleanup();
    };
    this.currentClose = close;
    DropdownToggleDirective.openClose = close;
    this.dismissStack.push(close);
    this.outsideClickHandler = (e: MouseEvent) => {
      // Close on any click except the trigger (handled by its own toggle): outside, or a picked item inside the content.
      if (this.host.nativeElement.contains(e.target as Node)) return;
      close();
    };
    // Tab trap: Tab uses the native focus order and would walk out of the menu; wrap it at the boundaries until dismissed.
    this.tabKeyHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !content) return;
      const items = Array.from(
        content.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Focus drifted outside (e.g. before the auto-focus settled) →
      // pull it back to the natural end of the cycle.
      if (!active || !content.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus({ preventScroll: true });
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', this.tabKeyHandler);
    setTimeout(() => {
      if (this.outsideClickHandler) {
        document.addEventListener('click', this.outsideClickHandler);
      }
    }, 0);
  }

  private close() {
    this.currentClose?.();
  }

  private cleanup() {
    if (this.outsideClickHandler) {
      document.removeEventListener('click', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
    if (this.tabKeyHandler) {
      document.removeEventListener('keydown', this.tabKeyHandler);
      this.tabKeyHandler = null;
    }
    if (this.currentClose) {
      this.dismissStack.remove(this.currentClose);
      if (DropdownToggleDirective.openClose === this.currentClose) {
        DropdownToggleDirective.openClose = null;
      }
      this.currentClose = null;
    }
  }
}
