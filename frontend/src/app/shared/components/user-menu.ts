import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { PopoverMenuComponent } from './popover-menu';
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
    PopoverMenuComponent,
    LucideUser, LucideSettings, LucideShield, LucideRepeat, LucideLogOut,
    LucideServer, LucideMonitorSmartphone,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      #trigger
      type="button"
      class="btn btn-ghost btn-circle"
      [attr.aria-label]="'nav.user_menu' | translate"
      (click)="open.set(!open())"
    >
      <svg lucideUser class="h-5 w-5"></svg>
    </button>
    <app-popover-menu
      [open]="open()"
      [anchor]="trigger"
      placement="bottom-end"
      (closed)="open.set(false)"
    >
      @if (auth.user(); as user) {
        <div class="flex items-center gap-3 px-4 py-3 border-b border-white/10">
          <div class="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center shrink-0">
            <svg lucideUser class="h-5 w-5 text-white/60"></svg>
          </div>
          <a routerLink="/account" class="min-w-0 flex-1 cursor-pointer" (click)="open.set(false)">
            <p class="font-semibold truncate text-white">{{ user.username }}</p>
            <p class="text-xs text-white/50">{{ user.role }}</p>
          </a>
        </div>
      }
      <a routerLink="/account" (click)="open.set(false)" class="w-full flex items-center gap-3 px-4 py-3.5 text-left text-base text-white rounded-lg active:bg-white/10 hover:bg-white/5">
        <svg lucideUser class="h-5 w-5 shrink-0 opacity-80"></svg>
        <span class="flex-1">{{ 'nav.account_settings' | translate }}</span>
      </a>
      <a routerLink="/app-settings" (click)="open.set(false)" class="w-full flex items-center gap-3 px-4 py-3.5 text-left text-base text-white rounded-lg active:bg-white/10 hover:bg-white/5">
        <svg lucideSettings class="h-5 w-5 shrink-0 opacity-80"></svg>
        <span class="flex-1">{{ 'nav.app_settings' | translate }}</span>
      </a>
      @if (auth.canAccessSettings()) {
        <a routerLink="/admin" (click)="open.set(false)" class="w-full flex items-center gap-3 px-4 py-3.5 text-left text-base text-white rounded-lg active:bg-white/10 hover:bg-white/5">
          <svg lucideShield class="h-5 w-5 shrink-0 opacity-80"></svg>
          <span class="flex-1">{{ 'nav.administration' | translate }}</span>
        </a>
      }
      <a routerLink="/pending-requests" (click)="open.set(false)" class="w-full flex items-center gap-3 px-4 py-3.5 text-left text-base text-white rounded-lg active:bg-white/10 hover:bg-white/5">
        <svg lucideMonitorSmartphone class="h-5 w-5 shrink-0 opacity-80"></svg>
        <span class="flex-1">{{ 'pending_requests.menu_entry' | translate }}</span>
      </a>
      <button type="button" (click)="switchUser()" class="w-full flex items-center gap-3 px-4 py-3.5 text-left text-base text-white rounded-lg active:bg-white/10 hover:bg-white/5">
        <svg lucideRepeat class="h-5 w-5 shrink-0 opacity-80"></svg>
        <span class="flex-1">{{ 'nav.switch_user' | translate }}</span>
      </button>
      @if (isNative) {
        <button type="button" (click)="changeServer()" class="w-full flex items-center gap-3 px-4 py-3.5 text-left text-base text-white rounded-lg active:bg-white/10 hover:bg-white/5">
          <svg lucideServer class="h-5 w-5 shrink-0 opacity-80"></svg>
          <span class="flex-1">{{ 'nav.change_server' | translate }}</span>
        </button>
      }
      <button type="button" (click)="logout()" class="w-full flex items-center gap-3 px-4 py-3.5 text-left text-base text-error rounded-lg active:bg-white/10 hover:bg-white/5">
        <svg lucideLogOut class="h-5 w-5 shrink-0"></svg>
        <span class="flex-1">{{ 'nav.logout' | translate }}</span>
      </button>
    </app-popover-menu>
  `,
})
export class UserMenuComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly serverConfig = inject(ServerConfigService);
  protected readonly isNative = Capacitor.isNativePlatform();
  protected readonly open = signal(false);

  protected switchUser() {
    this.open.set(false);
    this.router.navigate(['/login'], { queryParams: { switch: true } });
  }

  protected async changeServer() {
    this.open.set(false);
    await this.serverConfig.clear();
    this.router.navigate(['/setup']);
  }

  protected logout() {
    this.open.set(false);
    this.auth.logout();
  }
}
