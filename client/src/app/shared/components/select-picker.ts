import { Component, inject } from '@angular/core';
import { SelectPickerService } from '../../core/services/select-picker.service';
import { PopoverMenuComponent } from './popover-menu';

/** Singleton renderer for SelectPickerService: mount once at the layout root; shows a sheet (TV/touch) or dropdown (desktop) for `appTvSelect` selects. */
@Component({
  selector: 'app-select-picker',
  standalone: true,
  imports: [PopoverMenuComponent],
  templateUrl: './select-picker.html',
})
export class SelectPickerComponent {
  protected readonly picker = inject(SelectPickerService);
}
