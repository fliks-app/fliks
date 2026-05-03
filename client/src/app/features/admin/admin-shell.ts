import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { SettingsDrawerComponent } from '../../shared/components/settings-drawer/settings-drawer';
import {
  LucideLayoutGrid,
  LucideBarChart3,
  LucidePlay,
  LucideShield,
} from '@lucide/angular';

@Component({
  selector: 'app-admin-shell',
  imports: [
    RouterLink, RouterLinkActive, TranslateModule,
    SettingsDrawerComponent,
    LucideLayoutGrid, LucidePlay,
    LucideBarChart3, LucideShield,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-shell.html',
})
export class AdminShellComponent {}
