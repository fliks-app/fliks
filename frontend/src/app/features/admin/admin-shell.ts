import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Location } from '@angular/common';
import { ServerConfigService } from '../../core/services/server-config.service';
import {
  LucideChevronLeft,
  LucideSettings,
  LucideLayoutGrid,
  LucideUpload,
  LucideArrowRightLeft,
  LucideBarChart3,
  LucideShield,
} from '@lucide/angular';

@Component({
  selector: 'app-admin-shell',
  imports: [
    RouterOutlet, RouterLink, RouterLinkActive, TranslateModule,
    LucideChevronLeft, LucideSettings, LucideLayoutGrid, LucideUpload,
    LucideArrowRightLeft, LucideBarChart3, LucideShield,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-shell.html',
})
export class AdminShellComponent {
  private readonly location = inject(Location);
  readonly serverConfig = inject(ServerConfigService);

  goBack() {
    this.location.back();
  }
}
