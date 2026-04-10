import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ThemeService } from '../../core/services/theme.service';
import { TranslateModule } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { Capacitor } from '@capacitor/core';
import {
  LucideUser,
  LucideSettings,
  LucideShield,
  LucideRepeat,
  LucideLogOut,
  LucideSun,
  LucideMoon,
  LucideServer,
} from '@lucide/angular';

@Component({
  selector: 'app-user-menu',
  imports: [
    RouterLink, TranslateModule,
    LucideUser, LucideSettings, LucideShield, LucideRepeat, LucideLogOut,
    LucideSun, LucideMoon, LucideServer,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dropdown dropdown-end">
      <div tabindex="0" role="button" class="btn btn-ghost btn-circle">
        <svg lucideUser class="h-5 w-5"></svg>
      </div>
      <div tabindex="0" class="dropdown-content z-50 bg-base-200 rounded-xl shadow-xl w-60 mt-2 text-base-content">
        <!-- User header -->
        @if (auth.user(); as user) {
          <div class="flex items-center gap-3 px-4 py-3 border-b border-base-300">
            <div class="w-10 h-10 rounded-full bg-base-300 flex items-center justify-center shrink-0">
              <svg lucideUser class="h-5 w-5 text-base-content/40"></svg>
            </div>
            <a routerLink="/account" class="min-w-0 flex-1 hover:underline cursor-pointer">
              <p class="font-semibold truncate">{{ user.username }}</p>
              <p class="text-xs text-base-content/50">{{ user.role }}</p>
            </a>
            <button type="button" class="btn btn-ghost btn-sm btn-circle shrink-0" (click)="themeService.toggle(); $event.stopPropagation()">
              @if (themeService.theme() === 'dark') {
                <svg lucideSun class="h-4 w-4"></svg>
              } @else {
                <svg lucideMoon class="h-4 w-4"></svg>
              }
            </button>
          </div>
        }
        <!-- Menu items -->
        <ul class="menu w-full p-2">
          <li><a routerLink="/account" class="flex items-center gap-3 w-full"><svg lucideUser class="h-4 w-4 opacity-60"></svg>{{ 'nav.account_settings' | translate }}</a></li>
          <li><a routerLink="/app-settings" class="flex items-center gap-3 w-full"><svg lucideSettings class="h-4 w-4 opacity-60"></svg>{{ 'nav.app_settings' | translate }}</a></li>
          @if (auth.canAccessSettings()) {
            <li><a routerLink="/admin" class="flex items-center gap-3 w-full"><svg lucideShield class="h-4 w-4 opacity-60"></svg>{{ 'nav.administration' | translate }}</a></li>
          }
          <li><a (click)="switchUser()" class="flex items-center gap-3 w-full"><svg lucideRepeat class="h-4 w-4 opacity-60"></svg>{{ 'nav.switch_user' | translate }}</a></li>
          @if (isNative) {
            <li><a (click)="changeServer()" class="flex items-center gap-3 w-full"><svg lucideServer class="h-4 w-4 opacity-60"></svg>{{ 'nav.change_server' | translate }}</a></li>
          }
          <li><a (click)="auth.logout()" class="flex items-center gap-3 w-full text-error"><svg lucideLogOut class="h-4 w-4"></svg>{{ 'nav.logout' | translate }}</a></li>
        </ul>
      </div>
    </div>
  `,
})
export class UserMenuComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly serverConfig = inject(ServerConfigService);
  readonly themeService = inject(ThemeService);
  readonly isNative = Capacitor.isNativePlatform();

  switchUser() {
    this.router.navigate(['/login'], { queryParams: { switch: true } });
  }

  async changeServer() {
    await this.serverConfig.clear();
    this.router.navigate(['/setup']);
  }
}
