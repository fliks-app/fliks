import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LucideShield } from '@lucide/angular';
import { SettingsDrawerComponent } from '../../shared/components/settings-drawer/settings-drawer';
import { SettingsIconComponent } from './settings-icon';
import { SettingsSectionsService } from './settings-sections.service';

@Component({
  selector: 'app-admin-shell',
  imports: [
    RouterLink, RouterLinkActive, TranslateModule,
    SettingsDrawerComponent, SettingsIconComponent,
    LucideShield,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-shell.html',
})
export class AdminShellComponent {
  readonly sections = inject(SettingsSectionsService).sections;
}
