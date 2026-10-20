import { Directive, ElementRef, inject, input } from '@angular/core';

/** Marks the current option of a single-choice menu. `aria-disabled` rather than `disabled` keeps it in the D-pad focus order (see styles.css);
 * the click is swallowed in capture phase since re-picking the active track or quality costs a stream reload. */
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
