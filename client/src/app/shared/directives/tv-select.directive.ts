import { Directive, ElementRef, HostListener, inject, input } from '@angular/core';
import { SelectPickerService } from '../../core/services/select-picker.service';

/**
 * Apposed on a native `<select>`. Intercepts the open gesture (mouse,
 * Enter, Space) on every form factor and routes through
 * SelectPickerService for a consistent styled popover. The native element
 * stays in DOM as the value source so existing `[(ngModel)]` / `(change)`
 * bindings are unaffected.
 *
 * Arrow keys are intentionally NOT captured here: the global
 * `TvSpatialNavService` already preventDefaults arrow events on a focused
 * `<select appTvSelect>` (blocking native option-cycling) and decides the
 * next focus target — tree-aware when the surrounding region is annotated,
 * rect-based fallback otherwise. Adding arrow handlers here would race
 * with that.
 *
 * Usage: `<select appTvSelect [(ngModel)]="x">…</select>`
 */
@Directive({
  selector: 'select[appTvSelect]',
  standalone: true,
  host: { class: 'cursor-pointer transition-colors hover:bg-base-content/10' },
})
export class TvSelectDirective {
  private readonly host = inject<ElementRef<HTMLSelectElement>>(ElementRef);
  private readonly picker = inject(SelectPickerService);

  /** Optional sheet title shown above the option list. */
  readonly appTvSelect = input<string>('');

  @HostListener('mousedown', ['$event'])
  @HostListener('keydown.enter', ['$event'])
  @HostListener('keydown.space', ['$event'])
  protected onOpen(e: Event) {
    // Only the primary (left) button opens the picker — a right/middle click
    // falls through to the browser's default handling instead of hijacking it.
    if (e instanceof MouseEvent && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.picker.show(this.host.nativeElement, this.appTvSelect());
  }
}
