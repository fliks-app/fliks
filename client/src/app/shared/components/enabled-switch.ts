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

  private readonly checkbox = viewChild<ElementRef<HTMLInputElement>>('checkbox');

  constructor() {
    // A failed toggle leaves `enabled` unchanged, so [checked] has nothing to diff;
    // write `.checked` directly whenever nothing is in flight, bypassing that binding.
    effect(() => {
      const box = this.checkbox();
      if (box && !this.busy()) box.nativeElement.checked = this.enabled();
    });
  }

  onChange(): void {
    this.toggle.emit();
  }
}
