import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LucideShield } from '@lucide/angular';
import { SettingsDrawerComponent } from '../../shared/components/settings-drawer/settings-drawer';
import { SettingsIconComponent } from './settings-icon';
import { SettingsSectionsService } from './settings-sections.service';

@Component({
  selector: 'app-admin-shell',
  imports: [
    RouterLink, TranslateModule,
    SettingsDrawerComponent, SettingsIconComponent,
    LucideShield,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-shell.html',
})
export class AdminShellComponent {
  private readonly settings = inject(SettingsSectionsService);
  readonly sections = this.settings.sections;
  readonly activeItemId = this.settings.activeItemId;
}
