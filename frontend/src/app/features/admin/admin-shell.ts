import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { ServerConfigService } from '../../core/services/server-config.service';
import { SettingsDrawerComponent } from '../../shared/components/settings-drawer/settings-drawer';
import {
  LucideLayoutGrid,
  LucideUpload,
  LucideArrowRightLeft,
  LucideBarChart3,
  LucideShield,
} from '@lucide/angular';

@Component({
  selector: 'app-admin-shell',
  imports: [
    RouterLink, RouterLinkActive, TranslateModule,
    SettingsDrawerComponent,
    LucideLayoutGrid, LucideUpload,
    LucideArrowRightLeft, LucideBarChart3, LucideShield,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-shell.html',
})
export class AdminShellComponent {
  readonly serverConfig = inject(ServerConfigService);
}
