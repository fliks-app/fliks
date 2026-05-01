import { Directive, ElementRef, inject, OnDestroy } from '@angular/core';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';

/**
 * Click-driven `.dropdown-open` toggle for any DaisyUI dropdown trigger.
 *
 * DaisyUI's default open mechanism is `:focus-within`, which we explicitly
 * disable on TV to stop D-pad navigation from auto-opening dropdowns. With
 * focus-within out, dropdowns never open on TV — this directive provides
 * the missing click handler. On web/desktop the focus-within path still
 * works, so the directive is a non-disruptive add-on (clicking the trigger
 * just toggles a class that DaisyUI was already going to apply via focus).
 *
 * Outside clicks and the back button (via DismissableStackService) close
 * the dropdown.
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
  },
})
export class DropdownToggleDirective implements OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly dismissStack = inject(DismissableStackService);
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private currentClose: (() => void) | null = null;

  ngOnDestroy() {
    this.cleanup();
  }

  protected onClick(event: Event) {
    event.stopPropagation();
    const dropdown = this.host.nativeElement.closest<HTMLElement>('.dropdown');
    if (!dropdown) return;
    const isOpening = !dropdown.classList.contains('dropdown-open');
    if (isOpening) this.open(dropdown);
    else this.close();
  }

  private open(dropdown: HTMLElement) {
    dropdown.classList.add('dropdown-open');
    const close = () => {
      dropdown.classList.remove('dropdown-open');
      (this.host.nativeElement as HTMLElement).blur();
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
