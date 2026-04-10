import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { SettingsDrawerComponent } from '../../shared/components/settings-drawer/settings-drawer';
import { LucideUser, LucideLock } from '@lucide/angular';

@Component({
  selector: 'app-account-shell',
  imports: [
    RouterLink, RouterLinkActive, TranslateModule,
    SettingsDrawerComponent,
    LucideUser, LucideLock,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './account-shell.html',
})
export class AccountShellComponent {}
