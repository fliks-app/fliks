import { Component, inject } from '@angular/core';
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
  templateUrl: './select-picker.html',
})
export class SelectPickerComponent {
  protected readonly picker = inject(SelectPickerService);
}
