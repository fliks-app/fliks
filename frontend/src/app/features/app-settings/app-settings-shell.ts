import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { SettingsDrawerComponent } from '../../shared/components/settings-drawer/settings-drawer';
import { LucideSettings, LucidePlay, LucideCaptions, LucideCast } from '@lucide/angular';

@Component({
  selector: 'app-app-settings-shell',
  imports: [
    RouterLink, RouterLinkActive, TranslateModule,
    SettingsDrawerComponent,
    LucideSettings, LucidePlay, LucideCaptions, LucideCast,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-settings-shell.html',
})
export class AppSettingsShellComponent {}
