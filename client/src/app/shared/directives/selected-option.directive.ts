import { Directive, ElementRef, inject, input } from '@angular/core';

/**
 * Marks the option a single-choice menu is currently on.
 *
 * `disabled` would be the obvious way to make it unpickable, but it also drops
 * the element out of the focus order — a D-pad could then never land on the
 * value that is actually selected. `aria-disabled` keeps it reachable, styled
 * as unavailable (see the `[aria-disabled]` rule in styles.css), and lets
 * {@link initialOverlayFocus} put focus straight on it when the menu opens.
 *
 * The click is swallowed in the capture phase so the template's own `(click)`
 * never runs: re-picking the active audio track or quality costs a real stream
 * reload.
 */
@Directive({
  selector: '[appSelectedOption]',
  host: { '[attr.aria-disabled]': "selected() ? 'true' : null" },
})
export class SelectedOptionDirective {
  readonly selected = input.required<boolean>({ alias: 'appSelectedOption' });

  constructor() {
    inject(ElementRef<HTMLElement>).nativeElement.addEventListener(
      'click',
      (e: Event) => {
        if (!this.selected()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      { capture: true },
    );
  }
}
