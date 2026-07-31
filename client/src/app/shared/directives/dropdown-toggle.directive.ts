import { Directive, ElementRef, inject, OnDestroy } from '@angular/core';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';
import { TABBABLE_SELECTOR } from '../../core/services/focusable.constants';

/**
 * Click-driven `.dropdown-open` toggle for any DaisyUI dropdown trigger.
 *
 * DaisyUI's default open mechanism is `:focus-within`, which we neutralise
 * globally so Tab / D-pad focus alone never auto-opens a dropdown. With
 * focus-within out, this directive provides the click / keyboard activation
 * path. Outside clicks and the back button (via DismissableStackService)
 * close the dropdown.
 *
 * Usage:
 *   <div class="dropdown">
 *     <div appDropdownToggle tabindex="0" role="button">…</div>
 *     <div class="dropdown-content">…</div>
 *   </div>
 */

@Directive({
  selector: '[appDropdownToggle]',
  host: {
    '(click)': 'onClick($event)',
    '(keydown)': 'onKey($event)',
  },
})
export class DropdownToggleDirective implements OnDestroy {
  /** Close handler of the dropdown currently open, if any. Opening a
   *  dropdown closes this one first so only one stays open — the trigger's
   *  `stopPropagation` otherwise stops an open dropdown's outside-click
   *  handler from firing when another trigger is clicked. */
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
    // Move focus into the menu so arrow keys step between items
    // (spatial-nav scopes nav to `.dropdown-open .dropdown-content`)
    // and keyboard users can act without an extra Tab. Standard ARIA
    // menu pattern.
    queueMicrotask(() => {
      const first = content?.querySelector<HTMLElement>(TABBABLE_SELECTOR);
      first?.focus({ preventScroll: true });
    });
    const close = () => {
      dropdown.classList.remove('dropdown-open');
      this.triggerEl?.focus({ preventScroll: true });
      this.cleanup();
    };
    this.currentClose = close;
    DropdownToggleDirective.openClose = close;
    this.dismissStack.push(close);
    this.outsideClickHandler = (e: MouseEvent) => {
      // Close on any click that isn't the trigger itself: outside the
      // dropdown (typical click-out) AND inside the dropdown-content
      // (menu item picked → action handled elsewhere, dropdown should
      // dismiss). The trigger is handled by its own (click) toggle.
      if (this.host.nativeElement.contains(e.target as Node)) return;
      close();
    };
    // Tab trap: spatial-nav already scopes arrow keys when focus is
    // inside `.dropdown-open .dropdown-content`, but Tab uses the
    // browser's native focus order and walks straight out. Wrap Tab /
    // Shift+Tab at the menu boundaries so keyboard users stay inside
    // until they explicitly dismiss (Escape via DismissableStackService,
    // click outside, or pick an item).
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
