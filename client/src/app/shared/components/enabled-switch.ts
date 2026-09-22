import { Component, ElementRef, effect, input, output, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-enabled-switch',
  imports: [TranslatePipe],
  templateUrl: './enabled-switch.html',
})
export class EnabledSwitchComponent {
  readonly enabled = input.required<boolean>();
  readonly busy = input(false);
  readonly disabled = input(false);
  readonly ariaLabelKey = input('common.active');
  readonly toggle = output<void>();

  private readonly checkbox = viewChild.required<ElementRef<HTMLInputElement>>('checkbox');
  private wasBusy = false;

  constructor() {
    // A failed toggle leaves `enabled` unchanged, so [checked] has nothing to diff;
    // write `.checked` directly once `busy` clears, bypassing that binding.
    effect(() => {
      const busy = this.busy();
      if (this.wasBusy && !busy) {
        this.checkbox().nativeElement.checked = this.enabled();
      }
      this.wasBusy = busy;
    });
  }

  onChange(): void {
    this.toggle.emit();
  }
}
