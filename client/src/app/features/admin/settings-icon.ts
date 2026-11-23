import { Component, input } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../shared/icons';

/** Renders a `settings.page` contribution's icon by name; unrecognised names fall back to a generic circle, never blank. */
@Component({
  selector: 'app-settings-icon',
  imports: [LucideDynamicIcon],
  templateUrl: './settings-icon.html',
  styles: [`:host { display: inline-flex; } svg { width: 100%; height: 100%; }`],
})
export class SettingsIconComponent {
  protected readonly icons = icons;

  readonly name = input.required<string>();
}
