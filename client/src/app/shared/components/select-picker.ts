import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { SelectPickerService } from '../../core/services/select-picker.service';
import { TvService } from '../../core/services/tv.service';
import { FILTER_FROM_OPTIONS } from './forms/multi-select/multi-select';
import { PopoverMenuComponent } from './popover-menu';

/** Singleton renderer for SelectPickerService: mount once at the layout root; shows a sheet (TV/touch) or dropdown (desktop) for `appTvSelect` selects. */
@Component({
  selector: 'app-select-picker',
  standalone: true,
  imports: [FormsModule, TranslatePipe, PopoverMenuComponent],
  templateUrl: './select-picker.html',
})
export class SelectPickerComponent {
  protected readonly picker = inject(SelectPickerService);
  private readonly tv = inject(TvService);

  protected readonly query = signal('');
  /** No filter on TV: a D-pad can't type. */
  protected readonly showFilter = computed(
    () => !this.tv.isTv() && this.picker.options().length >= FILTER_FROM_OPTIONS,
  );
  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const all = this.picker.options();
    return q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all;
  });

  constructor() {
    effect(() => {
      if (!this.picker.open()) this.query.set('');
    });
  }
}
