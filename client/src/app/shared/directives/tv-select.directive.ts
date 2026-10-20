import { Directive, ElementRef, HostListener, inject, input } from '@angular/core';
import { SelectPickerService } from '../../core/services/select-picker.service';

/** On a native `<select>`: routes the open gesture through SelectPickerService, keeping the element as the value source for ngModel.
 *  Arrow keys are NOT captured: `TvSpatialNavService` already handles them on `<select appTvSelect>`, and handlers here would race. */
@Directive({
  selector: 'select[appTvSelect]',
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
