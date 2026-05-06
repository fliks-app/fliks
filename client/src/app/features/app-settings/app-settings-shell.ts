import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { SettingsDrawerComponent } from '../../shared/components/settings-drawer/settings-drawer';
import { LucideSettings, LucidePlay, LucideCaptions, LucideCast, LucideHardDrive } from '@lucide/angular';
import { TvService } from '../../core/services/tv.service';

@Component({
  selector: 'app-app-settings-shell',
  imports: [
    RouterLink, RouterLinkActive, TranslateModule,
    SettingsDrawerComponent,
    LucideSettings, LucidePlay, LucideCaptions, LucideCast, LucideHardDrive,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-settings-shell.html',
})
export class AppSettingsShellComponent {
  readonly tv = inject(TvService);
}
