import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { LucideBarChart3, LucideLayoutGrid, LucidePlay, LucideCircle } from '@lucide/angular';

/**
 * Renders a `settings.page` contribution's icon by name — a plugin can name
 * any string; unrecognised names fall back to a generic circle, never blank.
 */
@Component({
  selector: 'app-settings-icon',
  standalone: true,
  imports: [LucideBarChart3, LucideLayoutGrid, LucidePlay, LucideCircle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-icon.html',
  styles: [`:host { display: inline-flex; } svg { width: 100%; height: 100%; }`],
})
export class SettingsIconComponent {
  readonly name = input.required<string>();
}
