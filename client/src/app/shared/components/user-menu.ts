import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { ServerCacheService } from '../../core/services/server-cache.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { DropdownMenuComponent } from './dropdown-menu';
import { Capacitor } from '@capacitor/core';
import {
  LucideUser,
  LucideSettings,
  LucideShield,
  LucideRepeat,
  LucideLogOut,
  LucideServer,
  LucideMonitorSmartphone,
} from '@lucide/angular';

@Component({
  selector: 'app-user-menu',
  imports: [
    RouterLink, TranslateModule,
    DropdownMenuComponent,
    LucideUser, LucideSettings, LucideShield, LucideRepeat, LucideLogOut,
    LucideServer, LucideMonitorSmartphone,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-dropdown-menu placement="bottom-end">
      <button
        trigger
        type="button"
        class="btn btn-ghost btn-circle"
        [attr.aria-label]="'nav.user_menu' | translate"
      >
        <svg lucideUser class="h-5 w-5"></svg>
      </button>
      @if (auth.user(); as user) {
        <div class="flex items-center gap-3 px-3 py-3 border-b border-white/10">
          <div class="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center shrink-0">
            <svg lucideUser class="h-5 w-5 text-white/60"></svg>
          </div>
          <a routerLink="/account" class="min-w-0 flex-1 cursor-pointer">
            <p class="font-semibold truncate text-white">{{ user.username }}</p>
            <p class="text-xs text-white/50">{{ user.role }}</p>
          </a>
        </div>
      }
      <a routerLink="/account" class="dropdown-item text-white">
        <svg lucideUser class="h-5 w-5 shrink-0 opacity-80"></svg>
        <span class="flex-1">{{ 'nav.account_settings' | translate }}</span>
      </a>
      <a routerLink="/app-settings" class="dropdown-item text-white">
        <svg lucideSettings class="h-5 w-5 shrink-0 opacity-80"></svg>
        <span class="flex-1">{{ 'nav.app_settings' | translate }}</span>
      </a>
      @if (auth.canAccessSettings()) {
        <a routerLink="/admin" class="dropdown-item text-white">
          <svg lucideShield class="h-5 w-5 shrink-0 opacity-80"></svg>
          <span class="flex-1">{{ 'nav.administration' | translate }}</span>
        </a>
      }
      <a routerLink="/pending-requests" class="dropdown-item text-white">
        <svg lucideMonitorSmartphone class="h-5 w-5 shrink-0 opacity-80"></svg>
        <span class="flex-1">{{ 'pending_requests.menu_entry' | translate }}</span>
      </a>
      <button type="button" (click)="switchUser()" class="dropdown-item text-white">
        <svg lucideRepeat class="h-5 w-5 shrink-0 opacity-80"></svg>
        <span class="flex-1">{{ 'nav.switch_user' | translate }}</span>
      </button>
      @if (isNative) {
        <button type="button" (click)="changeServer()" class="dropdown-item text-white">
          <svg lucideServer class="h-5 w-5 shrink-0 opacity-80"></svg>
          <span class="flex-1">{{ 'nav.change_server' | translate }}</span>
        </button>
      }
      <button type="button" (click)="logout()" class="dropdown-item text-error">
        <svg lucideLogOut class="h-5 w-5 shrink-0"></svg>
        <span class="flex-1">{{ 'nav.logout' | translate }}</span>
      </button>
    </app-dropdown-menu>
  `,
})
export class UserMenuComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly serverCache = inject(ServerCacheService);
  protected readonly isNative = Capacitor.isNativePlatform();

  protected async switchUser() {
    await this.serverCache.clearAll();
    this.router.navigate(['/login'], { queryParams: { switch: true } });
  }

  protected async changeServer() {
    await this.serverCache.clearAll();
    await this.serverConfig.clear();
    this.router.navigate(['/setup']);
  }

  protected logout() {
    this.auth.logout();
  }
}
