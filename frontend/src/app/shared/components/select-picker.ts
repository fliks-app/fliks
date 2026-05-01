import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SelectPickerService } from '../../core/services/select-picker.service';
import { PopoverMenuComponent } from './popover-menu';

/**
 * Singleton renderer for SelectPickerService. Mount once at the app
 * layout root — it observes the service signals and displays a styled
 * option list (sheet on TV/touch, dropdown on desktop) for any <select>
 * decorated with `appTvSelect`.
 */
@Component({
  selector: 'app-select-picker',
  standalone: true,
  imports: [PopoverMenuComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-popover-menu
      [open]="picker.open()"
      [anchor]="picker.anchor()"
      placement="bottom-start"
      (closed)="picker.close()"
    >
      @if (picker.title()) {
        <div class="px-4 py-2 text-white/60 text-sm font-medium truncate">{{ picker.title() }}</div>
      }
      @for (opt of picker.options(); track opt.value) {
        <button
          type="button"
          [disabled]="opt.disabled"
          class="w-full flex items-center gap-3 px-4 py-3.5 text-left text-base rounded-lg active:bg-white/10 hover:bg-white/5 disabled:opacity-40"
          [class.text-primary]="opt.selected"
          [class.text-white]="!opt.selected"
          (click)="picker.pick(opt.value)"
        >
          <span class="flex-1 truncate">{{ opt.label }}</span>
          @if (opt.selected) {
            <span class="w-2 h-2 rounded-full bg-primary shrink-0"></span>
          }
        </button>
      }
    </app-popover-menu>
  `,
})
export class SelectPickerComponent {
  protected readonly picker = inject(SelectPickerService);
}
