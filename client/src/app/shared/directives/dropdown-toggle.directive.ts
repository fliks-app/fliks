import { Directive, ElementRef, inject, OnDestroy } from '@angular/core';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';

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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly dismissStack = inject(DismissableStackService);
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
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
    dropdown.classList.add('dropdown-open');
    const close = () => {
      dropdown.classList.remove('dropdown-open');
      this.triggerEl?.focus({ preventScroll: true });
      this.cleanup();
    };
    this.currentClose = close;
    this.dismissStack.push(close);
    this.outsideClickHandler = (e: MouseEvent) => {
      // Close on any click that isn't the trigger itself: outside the
      // dropdown (typical click-out) AND inside the dropdown-content
      // (menu item picked → action handled elsewhere, dropdown should
      // dismiss). The trigger is handled by its own (click) toggle.
      if (this.host.nativeElement.contains(e.target as Node)) return;
      close();
    };
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
    if (this.currentClose) {
      this.dismissStack.remove(this.currentClose);
      this.currentClose = null;
    }
  }
}
