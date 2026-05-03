import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Thin wrapper — navigation is handled by the sidebar dropdown in LayoutComponent.
 */
@Component({
  selector: 'app-settings-shell',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="w-full"><router-outlet /></div>`,
})
export class SettingsShellComponent {}
