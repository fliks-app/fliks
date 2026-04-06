import { Component, ChangeDetectionStrategy, inject, signal, OnInit, OnDestroy } from '@angular/core';
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
export class AdminShellComponent implements OnInit, OnDestroy {
  private readonly location = inject(Location);
  readonly serverConfig = inject(ServerConfigService);

  /** Same scroll-hide behavior as the main app layout mobile navbar. */
  readonly navbarHidden = signal(false);
  private lastScrollY = 0;
  private readonly onScroll = () => {
    const y = window.scrollY;
    if (Math.abs(y - this.lastScrollY) < 10) return;
    this.navbarHidden.set(y > this.lastScrollY && y > 56);
    this.lastScrollY = y;
  };

  ngOnInit() {
    window.addEventListener('scroll', this.onScroll, { passive: true });
  }

  ngOnDestroy() {
    window.removeEventListener('scroll', this.onScroll);
  }

  goBack() {
    this.location.back();
  }
}
