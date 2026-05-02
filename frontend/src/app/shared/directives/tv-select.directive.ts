import { Directive, ElementRef, HostListener, inject, input } from '@angular/core';
import { TvService } from '../../core/services/tv.service';
import { SelectPickerService } from '../../core/services/select-picker.service';

/**
 * Apposed on a native `<select>`. On TV, intercepts the open gesture
 * (Enter / Space / click) and routes through SelectPickerService for a
 * styled popover. The native element stays in DOM as the value source so
 * existing `[(ngModel)]` / `(change)` bindings are unaffected.
 *
 * Arrow keys are intentionally NOT captured here: the global
 * `TvSpatialNavService` already preventDefaults arrow events on a focused
 * `<select>` (blocking native option-cycling) and decides the next focus
 * target — tree-aware when the surrounding region is annotated, rect-based
 * fallback otherwise. Adding arrow handlers here would race with that.
 *
 * Usage: `<select appTvSelect [(ngModel)]="x">…</select>`
 */
@Directive({
  selector: 'select[appTvSelect]',
  standalone: true,
})
export class TvSelectDirective {
  private readonly host = inject<ElementRef<HTMLSelectElement>>(ElementRef);
  private readonly tv = inject(TvService);
  private readonly picker = inject(SelectPickerService);

  /** Optional sheet title shown above the option list. */
  readonly appTvSelect = input<string>('');

  @HostListener('mousedown', ['$event'])
  @HostListener('keydown.enter', ['$event'])
  @HostListener('keydown.space', ['$event'])
  protected onOpen(e: Event) {
    if (!this.tv.isTv()) return;
    e.preventDefault();
    e.stopPropagation();
    this.picker.show(this.host.nativeElement, this.appTvSelect());
  }
}
