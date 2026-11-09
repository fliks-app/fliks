import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideShield } from '@lucide/angular';
import { SettingsDrawerComponent } from '../../shared/components/settings-drawer/settings-drawer';
import { CardActionsPanelComponent } from '../../shared/components/card-actions-panel/card-actions-panel';
import { SettingsIconComponent } from './settings-icon';
import { SettingsSectionsService } from './settings-sections.service';

@Component({
  selector: 'app-admin-shell',
  imports: [
    CardActionsPanelComponent,
    RouterLink, TranslatePipe,
    SettingsDrawerComponent, SettingsIconComponent,
    LucideShield,
  ],
  templateUrl: './admin-shell.html',
})
export class AdminShellComponent {
  private readonly settings = inject(SettingsSectionsService);
  readonly sections = this.settings.sections;
  readonly activeItemId = this.settings.activeItemId;
}
